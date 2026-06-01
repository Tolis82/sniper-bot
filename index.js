require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const WebSocket = require('ws');
const bs58 = require('bs58');
const fs = require('fs');

const RPC = process.env.HELIUS_RPC;
const API_KEY = RPC.split('api-key=')[1];
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BUY_AMOUNT_SOL = 0.02;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN = false;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MAX_HOLD_MS = 30000;
const TAKE_PROFIT = 1.50;
const STOP_LOSS = 0.88;
const MIN_VSOL = 30;
const MAX_CREATOR_PCT = 8;
const MIN_INITIAL_BUY = 0.5;
const MOMENTUM_THRESHOLD = 1.03;
const MOMENTUM_WAIT_MS = 5000;
const DEAD_PRICE_THRESHOLD = 1.00;
const DEAD_PRICE_WAIT_MS = 10000;
const RUG_WORDS = ['usdc','united states dollar','dollar cat','scam','rug','fake','test','dump','honeypot','ponzi','elon','trump','biden','maga','doge','shib','pepe','wojak','moon','safe','based'];

const connection = new Connection(RPC, 'confirmed');
const decodedKey = bs58.default ? bs58.default.decode(PRIVATE_KEY) : bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(decodedKey);

let positions = {};
let isEntering = false;
let deployerCooldown = {};
let nameCooldown = {};
let recentTokens = new Set();
let globalWs = null;
let pingInterval = null;
let tokenCount = 0;
let candidateCount = 0;
let filterStats = { lowVsol: 0, zeroBuy: 0, highCreator: 0, lowInitBuy: 0, rugWord: 0, cooldown: 0, duplicate: 0 };
let safetyStats = { checked: 0, passed: 0, failedHoneypot: 0, failedTax: 0, failedLiquidity: 0, failedError: 0 };
let tradeStats = { total: 0, wins: 0, losses: 0, totalPnlSol: 0, totalTrades: 0 };

function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  axios.post('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    chat_id: TG_CHAT, text: msg
  }).catch(() => {});
}

function logTrade(data) {
  fs.appendFileSync('trades.log', JSON.stringify(data) + '\n');
}

function logSafety(data) {
  fs.appendFileSync('safety.log', JSON.stringify(data) + '\n');
}

function logPerformance(data) {
  fs.appendFileSync('performance.log', JSON.stringify(data) + '\n');
}

function parseCreateV2Data(logs) {
  for (const log of logs) {
    if (!log.startsWith('Program data:')) continue;
    try {
      const b64 = log.replace('Program data: ', '');
      const buf = Buffer.from(b64, 'base64');
      let offset = 8;
      const nameLen = buf.readUInt32LE(offset); offset += 4;
      if (nameLen > 100 || nameLen < 1) continue;
      const name = buf.slice(offset, offset + nameLen).toString('utf8'); offset += nameLen;
      const symLen = buf.readUInt32LE(offset); offset += 4;
      if (symLen > 20 || symLen < 1) continue;
      const symbol = buf.slice(offset, offset + symLen).toString('utf8'); offset += symLen;
      const uriLen = buf.readUInt32LE(offset); offset += 4;
      if (uriLen > 200 || uriLen < 1) continue;
      const uri = buf.slice(offset, offset + uriLen).toString('utf8');
      if (!uri.startsWith('http')) continue;
      return { name, symbol, uri };
    } catch(e) {}
  }
  return null;
}

async function getMintFromTx(sig) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise(r => setTimeout(r, 1500 * attempt));
    try {
      const res = await axios.post(RPC, {
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
      }, { timeout: 5000 });
      const tx = res.data.result;
      if (!tx) continue;
      const postBal = tx.meta.postTokenBalances;
      if (!postBal || postBal.length === 0) continue;
      const mint = postBal[0].mint;
      if (!mint) continue;
      return { mint };
    } catch(e) {}
  }
  return null;
}

async function getTokenBalance(mint) {
  try {
    // Έλεγχος σε Tokenz πρώτα
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }
    );
    for (const t of tokenAccounts.value) {
      if (t.account.data.parsed.info.mint === mint) {
        return parseInt(t.account.data.parsed.info.tokenAmount.amount);
      }
    }
    // Μετά σε Tokenkeg
    const tokenAccounts2 = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );
    for (const t of tokenAccounts2.value) {
      if (t.account.data.parsed.info.mint === mint) {
        return parseInt(t.account.data.parsed.info.tokenAmount.amount);
      }
    }
    return 0;
  } catch (err) {
    console.error('❌ Error getting balance:', err.message);
    return 0;
  }
}

async function safetyCheck(mint, name) {
  safetyStats.checked++;
  const testAmountLamports = Math.floor(BUY_AMOUNT_SOL * 1e9);
  const testTokenAmount = Math.floor(BUY_AMOUNT_SOL / 0.0000000338 * 1e6);
  try {
    const sellUrl = 'https://api.jup.ag/swap/v1/quote?inputMint=' + mint +
      '&outputMint=' + WSOL_MINT + '&amount=' + testTokenAmount + '&slippageBps=5000';
    let sellQuote;
    try {
      const sellRes = await axios.get(sellUrl, { timeout: 5000 });
      sellQuote = sellRes.data;
    } catch (err) {
      console.log('🚨 [SAFETY] HONEYPOT: ' + name);
      logSafety({ time: new Date().toISOString(), name, mint, result: 'HONEYPOT_NO_SELL_QUOTE' });
      safetyStats.failedHoneypot++;
      return { safe: false, reason: 'HONEYPOT_NO_SELL_QUOTE' };
    }
    if (sellQuote && sellQuote.outAmount) {
      const outLamports = parseFloat(sellQuote.outAmount);
      const returnRatio = outLamports / testAmountLamports;
      if (returnRatio < 1.20) {
        console.log('🚨 [SAFETY] HIGH TAX: ' + name + ' | Επιστροφή: ' + (returnRatio * 100).toFixed(1) + '%');
        logSafety({ time: new Date().toISOString(), name, mint, result: 'LOW_RETURN', returnRatio });
        safetyStats.failedTax++;
        return { safe: false, reason: 'LOW_RETURN', returnRatio };
      }
      if (outLamports < 1000) {
        console.log('🚨 [SAFETY] ZERO LIQUIDITY: ' + name);
        logSafety({ time: new Date().toISOString(), name, mint, result: 'ZERO_LIQUIDITY' });
        safetyStats.failedLiquidity++;
        return { safe: false, reason: 'ZERO_LIQUIDITY' };
      }
      console.log('✅ [SAFETY] PASS: ' + name + ' | Επιστροφή: ' + (returnRatio*100).toFixed(1) + '%');
      logSafety({ time: new Date().toISOString(), name, mint, result: 'PASS', returnRatio });
      safetyStats.passed++;
      return { safe: true, returnRatio };
    }
    safetyStats.failedError++;
    return { safe: false, reason: 'INCOMPLETE_DATA' };
  } catch (err) {
    safetyStats.failedError++;
    return { safe: false, reason: 'CHECK_ERROR' };
  }
}

async function getSellPrice(mint) {
  try {
    const PUMP_PK = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    const mintPubkey = new PublicKey(mint);
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
      PUMP_PK
    );
    const info = await connection.getAccountInfo(bondingCurve);
    if (!info || info.data.length < 24) return null;
    const vTokens = Number(info.data.readBigUInt64LE(8));
    const vSol = Number(info.data.readBigUInt64LE(16));
    if (!vTokens || !vSol) return null;
    return (vSol / 1e9) / (vTokens / 1e6);
  } catch (err) { return null; }
}

async function axiosGetWithRetry(url, opts = {}, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 429) {
        const wait = 500 * Math.pow(2, i);
        console.log('⏳ Rate limit (429), αναμονή ' + wait + 'ms...');
        await new Promise(r => setTimeout(r, wait));
      } else { throw err; }
    }
  }
  throw new Error('Max retries exceeded (429)');
}

async function axiosPostWithRetry(url, body, opts = {}, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios.post(url, body, opts);
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 429) {
        const wait = 500 * Math.pow(2, i);
        console.log('⏳ Rate limit (429), αναμονή ' + wait + 'ms...');
        await new Promise(r => setTimeout(r, wait));
      } else { throw err; }
    }
  }
  throw new Error('Max retries exceeded (429)');
}

async function executeBuy(mint) {
  try {
    const amountLamports = Math.floor(BUY_AMOUNT_SOL * 1e9);
    const quoteRes = await axiosGetWithRetry(
      'https://api.jup.ag/swap/v1/quote?inputMint=' + WSOL_MINT +
      '&outputMint=' + mint + '&amount=' + amountLamports + '&slippageBps=1500',
      { timeout: 8000 }
    );
    if (!quoteRes.data) { console.error('❌ No quote'); return null; }
    const tokenAmount = parseInt(quoteRes.data.outAmount);
    const swapRes = await axiosPostWithRetry('https://api.jup.ag/swap/v1/swap', {
      quoteResponse: quoteRes.data,
      userPublicKey: wallet.publicKey.toString(),
      prioritizationFeeLamports: 100000
    }, { timeout: 8000 });
    if (!swapRes.data) { console.error('❌ No swap TX'); return null; }
    const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    await Promise.race([
      connection.confirmTransaction(sig, 'confirmed'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('confirm timeout')), 60000))
    ]);
    console.log('✅ Buy TX: ' + sig);
    
    // Verify we actually received tokens
    await new Promise(r => setTimeout(r, 2000));
    const balance = await getTokenBalance(mint);
    if (balance === 0) {
      console.error('❌ CRITICAL: Buy TX confirmed but no tokens received!');
      return null;
    }
    console.log('✅ Tokens received: ' + balance);
    
    return { sig, tokenAmount: balance };
  } catch (err) {
    console.error('❌ Buy error: ' + err.message);
    return null;
  }
}

async function executeSell(mint, tokenAmount) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      
      // Get current balance
      const actualBalance = await getTokenBalance(mint);
      if (actualBalance === 0) {
        console.log('⚠️ No tokens to sell for ' + mint.slice(0,8) + ' (already sold?)');
        return 'already_sold';
      }
      
      const quoteRes = await axiosGetWithRetry(
        'https://api.jup.ag/swap/v1/quote?inputMint=' + mint +
        '&outputMint=' + WSOL_MINT + '&amount=' + actualBalance + '&slippageBps=5000',
        { timeout: 8000 }
      );
      if (!quoteRes.data) { 
        console.log('⚠️ No quote for sell, attempt ' + attempt + '/5');
        continue; 
      }
      
      const swapRes = await axiosPostWithRetry('https://api.jup.ag/swap/v1/swap', {
        quoteResponse: quoteRes.data,
        userPublicKey: wallet.publicKey.toString(),
        prioritizationFeeLamports: 500000
      }, { timeout: 8000 });
      if (!swapRes.data) { 
        console.log('⚠️ No swap TX for sell, attempt ' + attempt + '/5');
        continue; 
      }
      
      const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
      
      await Promise.race([
        connection.confirmTransaction(sig, 'confirmed'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('confirm timeout')), 60000))
      ]);
      
      // Verify sale
      await new Promise(r => setTimeout(r, 2000));
      const remainingBalance = await getTokenBalance(mint);
      if (remainingBalance > 0) {
        console.log('⚠️ Sell TX confirmed but ' + remainingBalance + ' tokens remain! Retrying...');
        continue;
      }
      
      console.log('✅ Sell TX: ' + sig + ' | All tokens sold');
      return sig;
    } catch (err) {
      console.error('❌ Sell attempt ' + attempt + '/5: ' + err.message);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  
  // Final check
  const finalBalance = await getTokenBalance(mint);
  if (finalBalance > 0) {
    console.error('❌ CRITICAL: Failed to sell all tokens after 5 attempts! ' + finalBalance + ' tokens remain');
    sendTelegram('🚨 CRITICAL: Failed to sell all tokens for ' + mint.slice(0,8) + '! Manual intervention needed!');
  }
  
  return null;
}

function monitorPosition(mint, name, entryPrice, tokenAmount) {
  let peakPrice = entryPrice;
  let sold = false;
  let sellAttempted = false;
  const startTime = Date.now();
  console.log('📊 ΑΓΟΡΑ: ' + name + ' | Entry: ' + entryPrice.toFixed(10) + ' | TP: +50% | SL: -12%');
  sendTelegram('📊 ΑΓΟΡΑ: ' + name + '\nEntry: ' + entryPrice.toFixed(10) + '\nΠοσό: ' + BUY_AMOUNT_SOL + ' SOL\nTP: +50% | SL: -12%');
  logTrade({ type: 'BUY', name, mint, entryPrice, amount: BUY_AMOUNT_SOL, time: new Date().toISOString() });

  async function closeTrade(currentPrice, reason) {
    if (sold || sellAttempted) return;
    sellAttempted = true;
    clearInterval(priceInterval);
    
    const multiplier = currentPrice / entryPrice;
    const pnl = ((multiplier - 1) * 100).toFixed(2);
    const pnlSol = (BUY_AMOUNT_SOL * (multiplier - 1)).toFixed(4);
    const emoji = multiplier >= 1 ? '🟢' : '🔴';
    const label = reason === 'TIME_EXIT' ? '⏰ TIME EXIT' : emoji + ' ΠΩΛΗΣΗ';
    
    console.log(label + ': ' + name + ' | x' + multiplier.toFixed(2) + ' | PnL: ' + pnl + '%');
    sendTelegram(label + ': ' + name + '\nPnL: ' + pnl + '%\nx' + multiplier.toFixed(2) + '\n' + (parseFloat(pnlSol) >= 0 ? '+' : '') + pnlSol + ' SOL');
    
    let sellResult = null;
    if (!DRY_RUN) {
      sellResult = await executeSell(mint, tokenAmount);
    }
    
    // Update trade stats
    tradeStats.total++;
    if (multiplier >= 1) {
      tradeStats.wins++;
    } else {
      tradeStats.losses++;
    }
    tradeStats.totalPnlSol += parseFloat(pnlSol);
    
    console.log('📊 Trade Stats | Total: ' + tradeStats.total + ' | Wins: ' + tradeStats.wins + ' | Losses: ' + tradeStats.losses + ' | Total PnL: ' + tradeStats.totalPnlSol.toFixed(4) + ' SOL');
    
    sold = true;
    delete positions[mint];
    isEntering = false;
    
    logTrade({ 
      type: 'SELL', 
      reason, 
      name, 
      mint, 
      entryPrice, 
      exitPrice: currentPrice, 
      multiplier, 
      pnl, 
      pnlSol, 
      sellSuccess: sellResult !== null,
      time: new Date().toISOString() 
    });
    
    logPerformance({
      time: new Date().toISOString(),
      totalTrades: tradeStats.total,
      wins: tradeStats.wins,
      losses: tradeStats.losses,
      totalPnlSol: tradeStats.totalPnlSol.toFixed(4),
      winRate: ((tradeStats.wins / tradeStats.total) * 100).toFixed(1) + '%'
    });
  }

  const priceInterval = setInterval(async () => {
    if (sold || sellAttempted) { 
      clearInterval(priceInterval); 
      return; 
    }
    
    const elapsed = Date.now() - startTime;
    
    // Time exit
    if (elapsed >= MAX_HOLD_MS) { 
      await closeTrade(peakPrice > entryPrice ? peakPrice * 0.9 : entryPrice, 'TIME_EXIT'); 
      return; 
    }
    
    const currentPrice = await getSellPrice(mint);
    if (!currentPrice) return;
    
    // Momentum check
    if ((elapsed < MOMENTUM_WAIT_MS && elapsed > 3000 && currentPrice < entryPrice * MOMENTUM_THRESHOLD) ||
        (elapsed > DEAD_PRICE_WAIT_MS && currentPrice < entryPrice * DEAD_PRICE_THRESHOLD)) {
      await closeTrade(currentPrice, 'MOMENTUM_EXIT'); 
      return;
    }
    
    // Sanity check
    if (currentPrice > entryPrice * 500) return;
    if (currentPrice > peakPrice) peakPrice = currentPrice;
    
    const multiplier = currentPrice / entryPrice;
    const peakMult = peakPrice / entryPrice;
    let stopLoss = peakMult < 1.15 ? STOP_LOSS : peakPrice * 0.85 / entryPrice;
    const remainingSec = Math.round((MAX_HOLD_MS - elapsed) / 1000);
    
    console.log('📈 ' + name + ' | x' + multiplier.toFixed(2) + ' | Peak: x' + peakMult.toFixed(2) + ' | SL: x' + stopLoss.toFixed(2) + ' | ⏱️ ' + remainingSec + 's');
    
    // Take profit
    if (multiplier >= TAKE_PROFIT) { 
      await closeTrade(currentPrice, 'TAKE_PROFIT'); 
      return; 
    }
    
    // Stop loss
    if (multiplier <= stopLoss) { 
      await closeTrade(currentPrice, 'STOP_LOSS'); 
      return; 
    }
  }, 1000);

  positions[mint] = { name, entryPrice, tokenAmount };
}

async function processToken({ mint, name, vSolInBondingCurve, vTokensInBondingCurve, solAmount, initialBuy, traderPublicKey }) {
  tokenCount++;
  
  if (tokenCount % 50 === 0) {
    console.log('📡 Seen: ' + tokenCount + ' | Candidates: ' + candidateCount + ' | Safety pass: ' + safetyStats.passed);
    console.log('🔍 Filters | zeroBuy: ' + filterStats.zeroBuy + ' | highCreator: ' + filterStats.highCreator + ' | lowInitBuy: ' + filterStats.lowInitBuy + ' | rugWord: ' + filterStats.rugWord + ' | duplicate: ' + filterStats.duplicate);
    console.log('📊 Performance | Trades: ' + tradeStats.total + ' | Wins: ' + tradeStats.wins + ' | Losses: ' + tradeStats.losses + ' | PnL: ' + tradeStats.totalPnlSol.toFixed(4) + ' SOL');
  }
  
  if (isEntering) return;
  if (Object.keys(positions).length >= 1) return;
  
  const vSol = vSolInBondingCurve || 30;
  const vTokens = vTokensInBondingCurve || 1000000000;
  const initialBuyAmt = solAmount || 0;
  const creatorPct = initialBuy ? (initialBuy / vTokens) * 100 : 0;
  const nameLower = name.toLowerCase();
  const deployer = traderPublicKey || '';
  
  // Filters
  if (vSol < MIN_VSOL) { filterStats.lowVsol++; return; }
  if (initialBuyAmt === 0) { filterStats.zeroBuy++; return; }
  if (creatorPct > MAX_CREATOR_PCT) { filterStats.highCreator++; return; }
  if (initialBuyAmt < MIN_INITIAL_BUY) { filterStats.lowInitBuy++; return; }
  if (RUG_WORDS.some(w => nameLower.includes(w))) { 
    filterStats.rugWord++; 
    console.log('🚫 Rug word: ' + name); 
    return; 
  }
  if (deployer && deployerCooldown[deployer] && Date.now() - deployerCooldown[deployer] < 10 * 60 * 1000) { 
    filterStats.cooldown++; 
    return; 
  }
  if (nameCooldown[nameLower] && Date.now() - nameCooldown[nameLower] < 30 * 60 * 1000) { 
    filterStats.cooldown++; 
    return; 
  }
  
  candidateCount++;
  isEntering = true;
  if (deployer) deployerCooldown[deployer] = Date.now();
  nameCooldown[nameLower] = Date.now();
  
  console.log('🎯 CANDIDATE #' + candidateCount + ': ' + name + ' | vSOL: ' + vSol.toFixed(2) + ' | Creator: ' + creatorPct.toFixed(2) + '% | InitBuy: ' + initialBuyAmt.toFixed(3) + ' SOL');
  
  // Safety check
  const safety = await safetyCheck(mint, name);
  if (!safety.safe) {
    console.log('🚫 [BLOCKED] ' + name + ' → ' + safety.reason);
    isEntering = false;
    return;
  }
  
  console.log('🚀 SNIPE: ' + name + ' | Safety OK (' + (safety.returnRatio * 100).toFixed(1) + '%)');
  
  if (DRY_RUN) {
    const entryPrice = vSol / vTokens;
    const tokenAmount = Math.floor(BUY_AMOUNT_SOL / entryPrice * 1e6);
    monitorPosition(mint, name, entryPrice, tokenAmount);
  } else {
    // Wait 2 seconds for initial volatility to settle
    console.log('⏳ Waiting 2s for price stabilization...');
    await new Promise(r => setTimeout(r, 2000));
    
    const result = await executeBuy(mint);
    if (!result) { 
      isEntering = false; 
      return; 
    }
    
    let entryPrice = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      entryPrice = await getSellPrice(mint);
      if (entryPrice && entryPrice > 0) break;
    }
    
    if (!entryPrice) {
      entryPrice = vSol / vTokens;
      console.log('⚠️ Fallback entry price: ' + entryPrice.toFixed(10));
    } else {
      console.log('✅ Real entry price: ' + entryPrice.toFixed(10));
    }
    
    monitorPosition(mint, name, entryPrice, result.tokenAmount);
  }
}

function startHeliusWebSocket() {
  if (pingInterval) clearInterval(pingInterval);
  globalWs = new WebSocket('wss://mainnet.helius-rpc.com/?api-key=' + API_KEY);
  
  globalWs.on('open', () => {
    console.log('⚡ Helius WebSocket συνδέθηκε (Node-Level Monitoring)');
    globalWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }]
    }));
    pingInterval = setInterval(() => {
      if (globalWs && globalWs.readyState === WebSocket.OPEN) globalWs.ping();
    }, 20000);
  });
  
  globalWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.params) return;
      
      const logs = msg.params.result.value.logs;
      const sig = msg.params.result.value.signature;
      
      if (!logs.some(l => l.includes('Instruction: CreateV2'))) return;
      
      const tokenData = parseCreateV2Data(logs);
      if (!tokenData) return;
      
      // Deduplication check
      const tokenKey = tokenData.name + '_' + tokenData.symbol;
      if (recentTokens.has(tokenKey)) {
        filterStats.duplicate++;
        return;
      }
      recentTokens.add(tokenKey);
      setTimeout(() => recentTokens.delete(tokenKey), 15000);
      
      console.log('⚡ [HELIUS] Νέο token: ' + tokenData.name + ' (' + tokenData.symbol + ')');
      
      const txData = await getMintFromTx(sig);
      if (!txData) { 
        console.log('⚠️ Δεν βρέθηκε mint για: ' + tokenData.name); 
        return; 
      }
      
      await processToken({
        mint: txData.mint,
        name: tokenData.name,
        vSolInBondingCurve: 30,
        vTokensInBondingCurve: 1000000000,
        solAmount: 1.0,
        initialBuy: 0,
        traderPublicKey: ''
      });
    } catch (err) {
      console.error('❌ Error processing message:', err.message);
    }
  });
  
  globalWs.on('close', (code) => {
    console.log('❌ Helius WS έκλεισε. Code: ' + code + ' | Επανασύνδεση σε 5s...');
    if (pingInterval) clearInterval(pingInterval);
    setTimeout(startHeliusWebSocket, 5000);
  });
  
  globalWs.on('error', (err) => {
    console.log('⚠️ Helius WS error: ' + err.message);
  });
}

console.log('✅ Bot started. Wallet: ' + wallet.publicKey.toString());
console.log(DRY_RUN ? '🧪 DRY-RUN MODE' : '🚀 LIVE MODE');
console.log('💰 Buy: ' + BUY_AMOUNT_SOL + ' SOL | TP: +50% | SL: -12% | Max: 30s');
console.log('⚡ Node-Level Monitoring: ΕΝΕΡΓΟ (Helius WebSocket)');
console.log('🛡️ Safety: ON | MinVsol: ' + MIN_VSOL + ' | MinInitBuy: ' + MIN_INITIAL_BUY + ' SOL | MaxCreator: ' + MAX_CREATOR_PCT + '%');
console.log('🔧 Deduplication: ON | Sell retries: 5x | Balance verification: ON');
startHeliusWebSocket();

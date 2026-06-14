    Εδώ είναι ολόκληρος ο κώδικας:

```javascript
require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const WebSocket = require('ws');
const bs58 = require('bs58');
const fs = require('fs');

const RPC = process.env.HELIUS_RPC;
const API_KEY = RPC.split('api-key=')[1];
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BUY_AMOUNT_SOL = 0.01;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN = true;
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
const MOONSHOT_RETURN_THRESHOLD = 2.0;
const MOONSHOT_BUY_SOL = 0.005;
const MOONSHOT_MAX_HOLD_MS = 90000;
const MOONSHOT_TAKE_PROFIT = 3.0;
const MOONSHOT_STOP_LOSS = 0.80;
const EARLY_EXIT_THRESHOLD = 0.85;
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
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }
    );
    for (const t of tokenAccounts.value) {
      if (t.account.data.parsed.info.mint === mint) {
        return parseInt(t.account.data.parsed.info.tokenAmount.amount);
      }
    }
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

async function executeBuy(mint, buyAmountSol) {
  const amount = buyAmountSol || BUY_AMOUNT_SOL;
  try {
    const amountLamports = Math.floor(amount * 1e9);
    const quoteRes = await axiosGetWithRetry(
      'https://api.jup.ag/swap/v1/quote?inputMint=' + WSOL_MINT +
      '&outputMint=' + mint + '&amount=' + amountLamports + '&slippageBps=1500',
      { timeout: 8000 }
    );
    if (!quoteRes.data) { console.error('❌ No quote'); return null; }
    const swapRes = await axiosPostWithRetry('https://api.jup.ag/swap/v1/swap', {
      quoteResponse: quoteRes.data,
      userPublicKey: wallet.publicKey.toString(),
      prioritizationFeeLamports: 300000
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
    await new Promise(r => setTimeout(r, 5000));
    let balance = await getTokenBalance(mint);
    if (balance === 0) {
      try {
        const txInfo = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (txInfo && txInfo.meta && txInfo.meta.postTokenBalances) {
          for (const tb of txInfo.meta.postTokenBalances) {
            if (tb.mint === mint) {
              balance = parseInt(tb.uiTokenAmount.amount);
              if (balance > 0) {
                console.log('✅ Tokens from TX: ' + balance);
                return { sig, tokenAmount: balance };
              }
            }
          }
        }
      } catch(e) {}
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
      const actualBalance = await getTokenBalance(mint);
      if (actualBalance === 0) {
        console.log('⚠️ No tokens to sell for ' + mint.slice(0,8) + ' (already sold?)');
        return 'already_sold';
      }
      try {
        const ppRes = await axios.post('https://pumpportal.fun/api/trade-local', {
          publicKey: wallet.publicKey.toString(),
          action: 'sell',
          mint: mint,
          amount: '100%',
          denominatedInSol: 'true',
          slippage: 50,
          priorityFee: 0.001,
          pool: 'pump'
        }, { responseType: 'arraybuffer', timeout: 10000 });
        if (ppRes.data && ppRes.data.byteLength > 100) {
          const txBuf = Buffer.from(ppRes.data);
          const tx = VersionedTransaction.deserialize(txBuf);
          tx.sign([wallet]);
          const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
          await connection.confirmTransaction(sig, 'confirmed');
          console.log('PumpPortal Sell OK: ' + sig);
          return sig;
        }
      } catch(ppErr) {
        console.log('PumpPortal sell failed, trying Jupiter: ' + ppErr.message);
      }
      const quoteRes = await axiosGetWithRetry(
        'https://api.jup.ag/swap/v1/quote?inputMint=' + mint +
        '&outputMint=' + WSOL_MINT + '&amount=' + actualBalance + '&slippageBps=5000',
        { timeout: 8000 }
      );
      if (!quoteRes.data) { continue; }
      const swapRes = await axiosPostWithRetry('https://api.jup.ag/swap/v1/swap', {
        quoteResponse: quoteRes.data,
        userPublicKey: wallet.publicKey.toString(),
        prioritizationFeeLamports: 500000
      }, { timeout: 8000 });
      if (!swapRes.data) { continue; }
      const txBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([wallet]);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
      await Promise.race([
        connection.confirmTransaction(sig, 'confirmed'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('confirm timeout')), 60000))
      ]);
      await new Promise(r => setTimeout(r, 2000));
      const remainingBalance = await getTokenBalance(mint);
      if (remainingBalance > 0) { continue; }
      console.log('✅ Sell TX: ' + sig + ' | All tokens sold');
      return sig;
    } catch (err) {
      console.error('❌ Sell attempt ' + attempt + '/5: ' + err.message);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  const finalBalance = await getTokenBalance(mint);
  if (finalBalance > 0) {
    console.error('❌ CRITICAL: Failed to sell all tokens after 5 attempts!');
    sendTelegram('🚨 CRITICAL: Failed to sell all tokens for ' + mint.slice(0,8) + '! Manual intervention needed!');
  }
  return null;
}

function monitorPosition(mint, name, entryPrice, tokenAmount, mode) {
  mode = mode || 'quick';
  const isMoonshot = mode === 'moonshot';
  const maxHold = isMoonshot ? MOONSHOT_MAX_HOLD_MS : MAX_HOLD_MS;
  const takeProfit = isMoonshot ? MOONSHOT_TAKE_PROFIT : TAKE_PROFIT;
  const stopLoss = isMoonshot ? MOONSHOT_STOP_LOSS : STOP_LOSS;
  const buyAmount = isMoonshot ? MOONSHOT_BUY_SOL : BUY_AMOUNT_SOL;
  if (isMoonshot) console.log('🌙 MOONSHOT MODE: ' + name);
  let peakPrice = entryPrice;
  let sold = false;
  let sellAttempted = false;
  const startTime = Date.now();
  console.log('📊 ΑΓΟΡΑ: ' + name + ' | Entry: ' + entryPrice.toFixed(10) + ' | Mode: ' + mode.toUpperCase() + ' | TP: ' + ((takeProfit-1)*100).toFixed(0) + '% | SL: ' + ((1-stopLoss)*100).toFixed(0) + '%');
  sendTelegram('📊 ΑΓΟΡΑ: ' + name + '\nEntry: ' + entryPrice.toFixed(10) + '\nMode: ' + mode.toUpperCase() + '\nΠοσό: ' + buyAmount + ' SOL\nTP: ' + ((takeProfit-1)*100).toFixed(0) + '% | SL: ' + ((1-stopLoss)*100).toFixed(0) + '%');
  logTrade({ type: 'BUY', name, mint, entryPrice, amount: buyAmount, time: new Date().toISOString() });

  async function closeTrade(currentPrice, reason) {
    if (sold || sellAttempted) return;
    sellAttempted = true;
    clearInterval(priceInterval);
    const multiplier = currentPrice / entryPrice;
    const pnl = ((multiplier - 1) * 100).toFixed(2);
    const pnlSol = (buyAmount * (multiplier - 1)).toFixed(4);
    const emoji = multiplier >= 1 ? '🟢' : '🔴';
    const label = reason === 'TIME_EXIT' ? '⏰ TIME EXIT' : emoji + ' ΠΩΛΗΣΗ';
    console.log(label + ': ' + name + ' | x' + multiplier.toFixed(2) + ' | PnL: ' + pnl + '%');
    sendTelegram(label + ': ' + name + '\nPnL: ' + pnl + '%\nx' + multiplier.toFixed(2) + '\n' + (parseFloat(pnlSol) >= 0 ? '+' : '') + pnlSol + ' SOL');
    let sellResult = null;
    if (!DRY_RUN) { sellResult = await executeSell(mint, tokenAmount); }
    tradeStats.total++;
    if (multiplier >= 1) { tradeStats.wins++; } else { tradeStats.losses++; }
    tradeStats.totalPnlSol += parseFloat(pnlSol);
    console.log('📊 Trade Stats | Total: ' + tradeStats.total + ' | Wins: ' + tradeStats.wins + ' | Losses: ' + tradeStats.losses + ' | Total PnL: ' + tradeStats.totalPnlSol.toFixed(4) + ' SOL');
    sold = true;
    delete positions[mint];
    isEntering = false;
    logTrade({ type: 'SELL', reason, name, mint, entryPrice, exitPrice: currentPrice, multiplier, pnl, pnlSol, sellSuccess: sellResult !== null, time: new Date().toISOString() });
    logPerformance({ time: new Date().toISOString(), totalTrades: tradeStats.total, wins: tradeStats.wins, losses: tradeStats.losses, totalPnlSol: tradeStats.totalPnlSol.toFixed(4), winRate: ((tradeStats.wins / tradeStats.total) * 100).toFixed(1) + '%' });
  }

  const priceInterval = setInterval(async () => {
    if (sold || sellAttempted) { clearInterval(priceInterval); return; }
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxHold) { await closeTrade(peakPrice > entryPrice ? peakPrice * 0.9 : entryPrice, 'TIME_EXIT'); return; }
    const currentPrice = await getSellPrice(mint);
    if (!currentPrice) return;
    if (elapsed < 3000 && currentPrice < entryPrice * EARLY_EXIT_THRESHOLD) { await closeTrade(currentPrice, 'EARLY_EXIT'); return; }
    if ((elapsed < MOMENTUM_WAIT_MS && elapsed > 3000 && currentPrice < entryPrice * MOMENTUM_THRESHOLD) ||
        (elapsed > DEAD_PRICE_WAIT_MS && currentPrice < entryPrice * DEAD_PRICE_THRESHOLD)) {
      await closeTrade(currentPrice, 'MOMENTUM_EXIT'); return;
    }
    if (currentPrice > entryPrice * 500) return;
    if (currentPrice > peakPrice) peakPrice = currentPrice;
    const multiplier = currentPrice / entryPrice;
    const peakMult = peakPrice / entryPrice;
    const dynamicSL = peakMult < 1.15 ? stopLoss : peakPrice * 0.85 / entryPrice;
    const remainingSec = Math.round((maxHold - elapsed) / 1000);
    console.log('📈 ' + name + ' | x' + multiplier.toFixed(2) + ' | Peak: x' + peakMult.toFixed(2) + ' | SL: x' + dynamicSL.toFixed(2) + ' | ⏱️ ' + remainingSec + 's');
    if (multiplier >= takeProfit) { await closeTrade(currentPrice, 'TAKE_PROFIT'); return; }
    if (multiplier <= dynamicSL) { await closeTrade(currentPrice, 'STOP_LOSS'); return; }
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
  if (vSol < MIN_VSOL) { filterStats.lowVsol++; return; }
  if (initialBuyAmt === 0) { filterStats.zeroBuy++; return; }
  if (creatorPct > MAX_CREATOR_PCT) { filterStats.highCreator++; return; }
  if (initialBuyAmt < MIN_INITIAL_BUY) { filterStats.lowInitBuy++; return; }
  if (RUG_WORDS.some(w => nameLower.includes(w))) { filterStats.rugWord++; console.log('🚫 Rug word: ' + name); return; }
  if (deployer && deployerCo

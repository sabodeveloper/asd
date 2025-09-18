import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { createPublicClient, http, webSocket, parseAbi } from 'viem';

// Monad Testnet chain config
const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  network: 'monad-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'MON',
    symbol: 'MON',
  },
  rpcUrls: {
    default: {
      http: ['https://monad-testnet.g.alchemy.com/v2/8QMlEIAdNyu3vAlf8e7XhoyRRwBiaFr5'],
    },
    public: {
      http: ['https://monad-testnet.g.alchemy.com/v2/8QMlEIAdNyu3vAlf8e7XhoyRRwBiaFr5'],
    },
  },
  blockExplorers: {
    default: { name: 'MonadScan', url: 'https://testnet.monad.xyz' },
  },
};

// Koleksiyon konfigürasyonu - Verify edilmiş koleksiyonlar
const COLLECTIONS = [
  {
    name: "MonBeans",
    address: "0x6aa4872ab4e0fdf078efd17acd45b6352f47c39c",
    tokenStart: 0,
    tokenEnd: 499,
    type: "ERC721",
    enabled: true
  },
  {
    name: "Spikes", 
    address: "0x87e1f1824c9356733a25d6bed6b9c87a3b31e107",
    tokenStart: 0,
    tokenEnd: 3332,
    type: "ERC721",
    enabled: true
  },
  {
    name: "TheDaks",
    address: "0x78ed9a576519024357ab06d9834266a04c9634b7",
    tokenStart: 0, 
    tokenEnd: 1554,
    type: "ERC721",
    enabled: true
  },
  {
    name: "SLMNDGenesis",
    address: "0xf7b984c089534ff656097e8c6838b04c5652c947",
    tokenStart: 0,
    tokenEnd: 3878,
    type: "ERC1155",
    enabled: false
  }
];

const wsUrls = [
  "wss://rpc-testnet.monadinfra.com/",
  "wss://monad-testnet.g.alchemy.com/v2/8QMlEIAdNyu3vAlf8e7XhoyRRwBiaFr5"
];

const BATCH_SIZE = 5;
const DELAY_BETWEEN_CALLS = 500;
const MAX_RETRIES = 5;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

// Her koleksiyon için ayrı data dosyası
const getDataFile = (collectionName) => `owners-${collectionName.toLowerCase().replace(/\s+/g, '-')}.json`;

let isFullSyncRunning = false;
let collectionsCache = {};

function readJSON(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const content = fs.readFileSync(file, 'utf8');
    if (!content.trim()) return {};
    return JSON.parse(content);
  } catch (err) {
    console.error(`JSON read error (${file}):`, err.message);
    return {};
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const httpClient = createPublicClient({
  chain: monadTestnet,
  transport: http("https://monad-testnet.g.alchemy.com/v2/8QMlEIAdNyu3vAlf8e7XhoyRRwBiaFr5"),
});

let wsClient;
let useWebSocket = false;

async function initWebSocket() {
  for (const wsUrl of wsUrls) {
    try {
      console.log(`🔌 WSS deneniyor: ${wsUrl}`);
      wsClient = createPublicClient({
        chain: monadTestnet,
        transport: webSocket(wsUrl, {
          reconnect: true,
          timeout: 30000,
        }),
      });
      await wsClient.getBlockNumber();
      useWebSocket = true;
      console.log(`✅ WSS bağlandı: ${wsUrl}`);
      return;
    } catch (err) {
      console.log(`❌ WSS başarısız (${wsUrl}): ${err.message}`);
    }
  }
  console.log('⚠️ WSS bağlanamadı, HTTP-only modda çalışacak');
  wsClient = httpClient;
  useWebSocket = false;
}

const erc721Abi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
]);

const erc1155Abi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
]);

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeOwnerOf(contractAddress, tokenId, contractType = 'ERC721', retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      await sleep(DELAY_BETWEEN_CALLS);
      
      if (contractType === 'ERC1155') {
        // ERC1155 için balanceOf kullan - owner'ı bulamayız, sadece balance check ederiz
        // Bu durumda token'ın var olup olmadığını kontrol ederiz
        const result = await httpClient.readContract({
          address: contractAddress,
          abi: erc1155Abi,
          functionName: 'balanceOf',
          args: ['0x0000000000000000000000000000000000000001', BigInt(tokenId)] // dummy address
        });
        
        // ERC1155 için owner tracking yapmıyoruz, sadece token'ın existence'ını check ediyoruz
        return 'ERC1155_EXISTS'; // Özel değer
      } else {
        // ERC721 için ownerOf kullan
        const result = await httpClient.readContract({
          address: contractAddress,
          abi: erc721Abi,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)]
        });
        
        return result;
      }
    } catch (err) {
      const isQueueError = err.message.includes('queue size exceeded');
      const isBlockError = err.message.includes('Block requested not found');
      const isNoFallback = err.message.includes('no fallback');
      const isNonExistent = err.message.includes('ERC721: invalid token ID') || 
                           err.message.includes('ERC721NonexistentToken') ||
                           err.message.includes('nonexistent token');
      
      if (isNoFallback || isNonExistent) {
        console.log(`⚠️ Token ${tokenId} mevcut değil (${isNoFallback ? 'no fallback' : 'nonexistent'})`);
        return null;
      }
      
      if (isQueueError || isBlockError) {
        const delay = RETRY_DELAYS[i] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.log(`⏳ Token ${tokenId} ownerOf retry ${i+1}/${retries} - ${delay}ms bekleniyor...`);
        await sleep(delay);
      } else {
        console.log(`❌ Token ${tokenId} ownerOf error: ${err.message}`);
        break;
      }
    }
  }
  return null;
}

async function updateToken(collection, tokenId) {
  try {
    const owner = await safeOwnerOf(collection.address, tokenId, collection.type);
    if (owner) {
      if (!collectionsCache[collection.name]) {
        collectionsCache[collection.name] = {};
      }
      
      if (collection.type === 'ERC1155') {
        // ERC1155 için özel işlem - owner tracking yapmıyoruz
        collectionsCache[collection.name][tokenId] = 'ERC1155_TOKEN';
        console.log(`[${collection.name}] Token ${tokenId} -> EXISTS (ERC1155)`);
      } else {
        collectionsCache[collection.name][tokenId] = owner.toLowerCase();
        console.log(`[${collection.name}] Token ${tokenId} -> OWNER ${owner.toLowerCase()}`);
      }
    } else {
      console.log(`⚠️ [${collection.name}] Token ${tokenId} - mevcut değil veya bulunamadı`);
    }
  } catch (err) {
    console.log(`❌ [${collection.name}] Token ${tokenId} update error: ${err.message}`);
  }
}

async function fetchAllOwners() {
  if (isFullSyncRunning) {
    console.log('⚠️ Full sync zaten çalışıyor...');
    return;
  }

  isFullSyncRunning = true;
  console.log('🔄 Multi-Collection NFT Owner sync başlıyor...');

  // Her koleksiyon için cache'i başlat
  for (const collection of COLLECTIONS.filter(c => c.enabled)) {
    const dataFile = getDataFile(collection.name);
    collectionsCache[collection.name] = readJSON(dataFile);
    console.log(`📂 [${collection.name}] Mevcut data yüklendi - Owners: ${Object.keys(collectionsCache[collection.name]).length}`);
  }

  // Her koleksiyon için ayrı ayrı sync
  for (const collection of COLLECTIONS.filter(c => c.enabled)) {
    console.log(`\n🔄 [${collection.name}] Sync başlıyor...`);
    
    const totalTokens = collection.tokenEnd - collection.tokenStart + 1;
    const totalBatches = Math.ceil(totalTokens / BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startToken = collection.tokenStart + (batchIndex * BATCH_SIZE);
      const endToken = Math.min(startToken + BATCH_SIZE - 1, collection.tokenEnd);
      
      console.log(`📦 [${collection.name}] Batch ${batchIndex + 1}/${totalBatches} - Token ${startToken}-${endToken}`);

      const batch = [];
      for (let tokenId = startToken; tokenId <= endToken; tokenId++) {
        batch.push(updateToken(collection, tokenId));
      }
      
      await Promise.all(batch);
      
      // Her batch sonunda dosyayı güncelle
      const dataFile = getDataFile(collection.name);
      writeJSON(dataFile, collectionsCache[collection.name]);
      console.log(`💾 [${collection.name}] Batch ${batchIndex + 1} kaydedildi - Toplam owner: ${Object.keys(collectionsCache[collection.name]).length}`);
    }
    
    console.log(`✅ [${collection.name}] Sync tamamlandı. Toplam ${Object.keys(collectionsCache[collection.name]).length} token bulundu.`);
  }

  isFullSyncRunning = false;
  console.log(`✅ Multi-Collection NFT Owner sync tamamlandı!`);
}

// Event monitoring
function setupEventWatcher() {
  if (!useWebSocket) return console.log("⚠️ WSS aktif değil");

  console.log("🟢 Event listener kuruluyor...");
  let retryCount = 0;
  const maxRetries = 10;
  let unwatch = null;

  const startWatching = () => {
    try {
      for (const collection of COLLECTIONS.filter(c => c.enabled)) {
        const abi = collection.type === 'ERC1155' ? erc1155Abi : erc721Abi;
        const eventName = collection.type === 'ERC1155' ? 'TransferSingle' : 'Transfer';
        
        unwatch = wsClient.watchContractEvent({
          address: collection.address,
          abi: abi,
          eventName: eventName,
          onLogs: async (logs) => {
            retryCount = 0;
            for (const log of logs) {
              if (collection.type === 'ERC1155') {
                // ERC1155 TransferSingle event: (operator, from, to, id, value)
                const { from, to, id } = log.args;
                const tokenIdNumber = Number(id);
                
                console.log(`📨 [${collection.name}] ERC1155 Transfer: token ${tokenIdNumber} ${from} -> ${to}`);
                
                // ERC1155 için owner tracking yapmıyoruz, sadece existence
                if (collectionsCache[collection.name]) {
                  if (to === '0x0000000000000000000000000000000000000000') {
                    // Burn event - token'ı sil
                    delete collectionsCache[collection.name][tokenIdNumber];
                    console.log(`🔥 [${collection.name}] Token ${tokenIdNumber} burned`);
                  } else {
                    // Token exists
                    collectionsCache[collection.name][tokenIdNumber] = 'ERC1155_TOKEN';
                    console.log(`✅ [${collection.name}] Token ${tokenIdNumber} updated: ERC1155_TOKEN`);
                  }
                  
                  // Dosyaya kaydet
                  const dataFile = getDataFile(collection.name);
                  writeJSON(dataFile, collectionsCache[collection.name]);
                }
              } else {
                // ERC721 Transfer event: (from, to, tokenId)
                const { from, to, tokenId } = log.args;
                const tokenIdNumber = Number(tokenId);
                
                console.log(`📨 [${collection.name}] ERC721 Transfer: token ${tokenIdNumber} ${from} -> ${to}`);
                
                // Cache'i güncelle
                if (collectionsCache[collection.name]) {
                  if (to === '0x0000000000000000000000000000000000000000') {
                    // Burn event - token'ı sil
                    delete collectionsCache[collection.name][tokenIdNumber];
                    console.log(`🔥 [${collection.name}] Token ${tokenIdNumber} burned`);
                  } else {
                    // Normal transfer - owner'ı güncelle
                    collectionsCache[collection.name][tokenIdNumber] = to.toLowerCase();
                    console.log(`✅ [${collection.name}] Token ${tokenIdNumber} owner updated: ${to}`);
                  }
                  
                  // Dosyaya kaydet
                  const dataFile = getDataFile(collection.name);
                  writeJSON(dataFile, collectionsCache[collection.name]);
                }
              }
            }
          },
          onError: (err) => {
            console.error(`❌ [${collection.name}] WSS error:`, err.message);
            if (unwatch) try { unwatch(); } catch {}
            if (retryCount < maxRetries) {
              retryCount++;
              const delay = Math.min(2000 * retryCount, 30000);
              console.log(`🔄 [${collection.name}] WSS reconnecting in ${delay}ms...`);
              setTimeout(startWatching, delay);
            } else {
              console.log(`⛔ [${collection.name}] WSS kapatıldı, HTTP-only mod`);
              useWebSocket = false;
            }
          },
        });
        console.log(`👂 [${collection.name}] Event monitoring aktif (WSS)`);
      }
    } catch (err) {
      console.error("WSS watcher start error:", err.message);
    }
  };

  startWatching();
}

// Express API
const app = express();
app.use(cors());

// Tüm koleksiyonların owner'larını getir
app.get('/owners', (req, res) => {
  const allOwners = {};
  
  for (const collection of COLLECTIONS.filter(c => c.enabled)) {
    const dataFile = getDataFile(collection.name);
    const data = Object.keys(collectionsCache[collection.name] || {}).length > 0 
      ? collectionsCache[collection.name] 
      : readJSON(dataFile);
    
    allOwners[collection.name] = {
      address: collection.address,
      owners: data
    };
  }
  
  res.json(allOwners);
});

// Belirli bir koleksiyonun owner'larını getir
app.get('/owners/:collectionName', (req, res) => {
  const collectionName = req.params.collectionName;
  const collection = COLLECTIONS.find(c => c.name.toLowerCase() === collectionName.toLowerCase());
  
  if (!collection) {
    return res.status(404).json({ error: 'Collection not found' });
  }
  
  const dataFile = getDataFile(collection.name);
  const data = Object.keys(collectionsCache[collection.name] || {}).length > 0 
    ? collectionsCache[collection.name] 
    : readJSON(dataFile);
  
  res.json({
    collection: collection.name,
    address: collection.address,
    owners: data
  });
});

// Belirli bir token'ın owner'ını getir
app.get('/owners/:collectionName/:tokenId', (req, res) => {
  const collectionName = req.params.collectionName;
  const tokenId = req.params.tokenId;
  const collection = COLLECTIONS.find(c => c.name.toLowerCase() === collectionName.toLowerCase());
  
  if (!collection) {
    return res.status(404).json({ error: 'Collection not found' });
  }
  
  const dataFile = getDataFile(collection.name);
  const data = Object.keys(collectionsCache[collection.name] || {}).length > 0 
    ? collectionsCache[collection.name] 
    : readJSON(dataFile);
  
  const owner = data[tokenId];
  
  if (!owner) {
    return res.status(404).json({ error: 'Token not found' });
  }
  
  res.json({
    collection: collection.name,
    tokenId,
    owner
  });
});

// Manual refresh endpoint
app.get('/owners/refresh', async (req, res) => {
  try {
    await fetchAllOwners();
    res.json({ success: true, message: 'All collections refreshed', data: collectionsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Belirli koleksiyonu refresh et
app.get('/owners/:collectionName/refresh', async (req, res) => {
  const collectionName = req.params.collectionName;
  const collection = COLLECTIONS.find(c => c.name.toLowerCase() === collectionName.toLowerCase());
  
  if (!collection) {
    return res.status(404).json({ error: 'Collection not found' });
  }
  
  try {
    console.log(`🔄 [${collection.name}] Manual refresh başlıyor...`);
    
    const totalTokens = collection.tokenEnd - collection.tokenStart + 1;
    const totalBatches = Math.ceil(totalTokens / BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startToken = collection.tokenStart + (batchIndex * BATCH_SIZE);
      const endToken = Math.min(startToken + BATCH_SIZE - 1, collection.tokenEnd);
      
      const batch = [];
      for (let tokenId = startToken; tokenId <= endToken; tokenId++) {
        batch.push(updateToken(collection, tokenId));
      }
      
      await Promise.all(batch);
    }
    
    const dataFile = getDataFile(collection.name);
    writeJSON(dataFile, collectionsCache[collection.name]);
    
    res.json({ 
      success: true, 
      message: `${collection.name} refreshed`, 
      data: collectionsCache[collection.name] 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Koleksiyon bilgilerini getir
app.get('/collections', (req, res) => {
  const collectionsInfo = COLLECTIONS.filter(c => c.enabled).map(collection => ({
    name: collection.name,
    address: collection.address,
    tokenStart: collection.tokenStart,
    tokenEnd: collection.tokenEnd,
    enabled: collection.enabled,
    totalSupply: collection.tokenEnd - collection.tokenStart + 1
  }));
  
  res.json(collectionsInfo);
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = {};
  
  for (const collection of COLLECTIONS.filter(c => c.enabled)) {
    const dataFile = getDataFile(collection.name);
    const data = Object.keys(collectionsCache[collection.name] || {}).length > 0 
      ? collectionsCache[collection.name] 
      : readJSON(dataFile);
    
    const totalOwners = new Set(Object.values(data)).size;
    
    stats[collection.name] = {
      totalTokens: Object.keys(data).length,
      totalOwners: totalOwners,
      address: collection.address
    };
  }
  
  res.json({
    collections: stats,
    lastUpdated: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`🚀 Multi-Collection NFT Owner API Server running on http://localhost:${PORT}`);
  console.log(`📍 Available Endpoints:`);
  console.log(`   All Collections: http://localhost:${PORT}/owners`);
  console.log(`   Collection Owners: http://localhost:${PORT}/owners/:collectionName`);
  console.log(`   Token Owner: http://localhost:${PORT}/owners/:collectionName/:tokenId`);
  console.log(`   Collections Info: http://localhost:${PORT}/collections`);
  console.log(`   Stats: http://localhost:${PORT}/stats`);
  console.log(`   Refresh All: http://localhost:${PORT}/owners/refresh`);
  console.log(`   Refresh Collection: http://localhost:${PORT}/owners/:collectionName/refresh`);

  // Her koleksiyon için cache'i başlat
  for (const collection of COLLECTIONS.filter(c => c.enabled)) {
    const dataFile = getDataFile(collection.name);
    collectionsCache[collection.name] = readJSON(dataFile);
    console.log(`📂 [${collection.name}] Mevcut data yüklendi - Owners: ${Object.keys(collectionsCache[collection.name]).length}`);
  }

  await initWebSocket();
  await fetchAllOwners();
  
  // Real-time event monitoring başlat
  if (useWebSocket) {
    setupEventWatcher();
  }

  console.log(`✅ Multi-Collection NFT Owner API ready!`);
});
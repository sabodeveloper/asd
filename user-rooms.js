import express from 'express';
import cors from 'cors';
import { createPublicClient, http } from 'viem';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

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

// Config objesi - yeni deploy edilen adreslerle
const config = {
  rpc: {
    monadTestnet: {
      http: "https://monad-testnet.g.alchemy.com/v2/8QMlEIAdNyu3vAlf8e7XhoyRRwBiaFr5"
    }
  },
  contracts: {
    otcSwapManager: "0xB16Fac906C36de46da4010Fbb19F868Bc2449292", // Yeni deploy edilen adres
    verifiedRegistry: "0xcC77804CE6cfb86BF9EE31D45C5e397d6b63853d"  // Yeni deploy edilen adres
  },
  collections: [
    {
      name: "MonBeans",
      address: "0x6aa4872ab4e0fdf078efd17acd45b6352f47c39c",
      tokenStart: 0,
      tokenEnd: 499,
      enabled: true
    },
    {
      name: "Spikes", 
      address: "0x87e1f1824c9356733a25d6bed6b9c87a3b31e107",
      tokenStart: 0,
      tokenEnd: 999,
      enabled: true
    },
    {
      name: "TheDaks",
      address: "0x78ed9a576519024357ab06d9834266a04c9634b7",
      tokenStart: 0, 
      tokenEnd: 999,
      enabled: true
    },
    {
      name: "SLMNDGenesis",
      address: "0xf7b984c089534ff656097e8c6838b04c5652c947",
      tokenStart: 0,
      tokenEnd: 999,
      enabled: true
    }
  ],
  ports: {
    userRoomsAPI: 3001
  },
  api: {
    rateLimit: {
      batchSize: 5,
      delayBetweenCalls: 200,
      delayBetweenBatches: 1000
    },
    cache: {
      userRoomsTTL: 5 * 60 * 1000 // 5 dakika (kullanılmıyor artık)
    }
  },
  
  // Helper functions
  getCollectionByAddress: function(address) {
    return this.collections.find(c => c.address.toLowerCase() === address.toLowerCase());
  },
  
  getEnabledCollections: function() {
    return this.collections.filter(c => c.enabled);
  }
};

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Config'den değerleri al
const RPC_URL = config.rpc.monadTestnet.http;
const CONTRACT_ADDRESS = config.contracts.otcSwapManager;

// Collection address'ini collection name'e çeviren helper
const getCollectionNameByAddress = (address) => {
  const collection = config.getCollectionByAddress(address);
  return collection ? collection.name : 'Unknown Collection';
};


// NFT display name helper
const getDisplayName = (collectionAddress, tokenId) => {
  const collection = config.getCollectionByAddress(collectionAddress);
  if (collection) {
    return `${collection.name} #${tokenId}`;
  }
  return `NFT #${tokenId}`;
};


// Viem client
const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL)
});

// ABI - sadece ihtiyacımız olan fonksiyonlar
const OTC_SWAP_MANAGER_ABI = [
  {
    "inputs": [{"name": "user", "type": "address"}],
    "name": "getUserRooms",
    "outputs": [{"name": "", "type": "uint256[]"}],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{"name": "roomId", "type": "uint256"}],
    "name": "getRoom",
    "outputs": [
      {"name": "maker", "type": "address"},
      {"name": "taker", "type": "address"},
      {"name": "expiry", "type": "uint256"},
      {"name": "settled", "type": "bool"},
      {"name": "cancelled", "type": "bool"},
      {"name": "makerDeposited", "type": "bool"},
      {"name": "takerDeposited", "type": "bool"},
      {"name": "makerClaimed", "type": "bool"},
      {"name": "takerClaimed", "type": "bool"}
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{"name": "roomId", "type": "uint256"}],
    "name": "getRoomAssets",
    "outputs": [
      {
        "components": [
          {"name": "kind", "type": "uint8"},
          {"name": "token", "type": "address"},
          {"name": "id", "type": "uint256"},
          {"name": "amount", "type": "uint256"}
        ],
        "name": "makerAssets",
        "type": "tuple[]"
      },
      {
        "components": [
          {"name": "kind", "type": "uint8"},
          {"name": "token", "type": "address"},
          {"name": "id", "type": "uint256"},
          {"name": "amount", "type": "uint256"}
        ],
        "name": "takerAssets",
        "type": "tuple[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// JSON dosya yolu
const ROOMS_DATA_PATH = path.join(process.cwd(), 'userRooms.json');

// Cache stratejileri - duruma göre farklı TTL'ler
const CACHE_STRATEGIES = {
  // Final durumlar - uzun cache (30 dakika)
  final_states: 30 * 60 * 1000,
  
  // Expire olmuş room'lar - orta cache (3 dakika)
  expired_rooms: 3 * 60 * 1000,
  
  // Aktif room'lar - hızlı cache (30 saniye)
  active_rooms: 30 * 1000,
  
  // Kritik expire (5 dk kaldı) - çok hızlı (10 saniye)
  critical_expiry: 10 * 1000
};

// Rate limiting ve kuyruk yönetimi
class RequestQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxConcurrent = 2; // Aynı anda max 2 blockchain sorgusu
    this.currentRequests = 0;
    this.requestDelay = 500; // Normal durumda 500ms delay
    this.highLoadDelay = 2000; // Yoğunlukta 2s delay
    this.requestCount = 0;
    this.lastMinuteRequests = [];
  }
  
  // Son 1 dakikadaki istek sayısını hesapla
  getRecentRequestCount() {
    const oneMinuteAgo = Date.now() - 60 * 1000;
    this.lastMinuteRequests = this.lastMinuteRequests.filter(time => time > oneMinuteAgo);
    return this.lastMinuteRequests.length;
  }
  
  // Yoğunluk durumunu kontrol et
  isHighLoad() {
    return this.getRecentRequestCount() > 10; // Dakikada 10'dan fazla istek = yoğun
  }
  
  // İsteği kuyruğa ekle
  async enqueue(requestFn, userAddress) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, userAddress, resolve, reject, timestamp: Date.now() });
      this.processQueue();
    });
  }
  
  // Kuyruğu işle
  async processQueue() {
    if (this.processing || this.currentRequests >= this.maxConcurrent) {
      return;
    }
    
    const item = this.queue.shift();
    if (!item) {
      return;
    }
    
    this.processing = true;
    this.currentRequests++;
    
    try {
      const delay = this.isHighLoad() ? this.highLoadDelay : this.requestDelay;
      console.log(`⏳ Processing request for ${item.userAddress}, queue: ${this.queue.length}, load: ${this.isHighLoad() ? 'HIGH' : 'NORMAL'}, delay: ${delay}ms`);
      
      // Delay uygula
      if (this.requestCount > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // İsteği çalıştır
      const result = await item.requestFn();
      
      // İstatistikleri güncelle
      this.requestCount++;
      this.lastMinuteRequests.push(Date.now());
      
      item.resolve(result);
    } catch (error) {
      console.error(`❌ Queue request failed for ${item.userAddress}:`, error);
      item.reject(error);
    } finally {
      this.currentRequests--;
      this.processing = false;
      
      // Kuyruktaki diğer istekleri işle
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 100);
      }
    }
  }
}

// Global request queue
const requestQueue = new RequestQueue();

// Room status belirleme
const determineStatus = (roomData) => {
  const { settled, cancelled, makerDeposited, takerDeposited, expiry } = roomData;
  
  if (cancelled) return 'cancelled';
  if (settled) return 'completed';
  if (takerDeposited && makerDeposited) return 'matched';
  if (makerDeposited) return 'waiting_for_taker';
  if (Date.now() > Number(expiry) * 1000) return 'expired';
  return 'created';
};

// Akıllı cache TTL belirleme
const getSmartCacheTTL = (room) => {
  const now = Date.now();
  const timeUntilExpiry = room.expiry - now;
  
  // Final durumlar - uzun cache
  if (room.status === 'completed' || room.status === 'cancelled') {
    return CACHE_STRATEGIES.final_states;
  }
  
  // Expire olmuş - orta cache (değişmez artık)
  if (room.status === 'expired') {
    return CACHE_STRATEGIES.expired_rooms;
  }
  
  // 5 dakikadan az kaldı - kritik
  if (timeUntilExpiry < 5 * 60 * 1000) {
    return CACHE_STRATEGIES.critical_expiry;
  }
  
  // 15 dakikadan az kaldı - yakında expire (30 saniye cache)
  if (timeUntilExpiry < 15 * 60 * 1000) {
    return 30 * 1000; // 30 saniye
  }
  
  // Normal aktif room'lar
  return CACHE_STRATEGIES.active_rooms;
};

// Cache'in fresh olup olmadığını kontrol et
const isCacheFresh = (cachedData, forceRefresh) => {
  if (forceRefresh === 'true' || !cachedData) {
    return false;
  }
  
  const now = Date.now();
  
  // Her room için kendi TTL'sine göre kontrol et
  for (const room of cachedData.rooms) {
    const roomTTL = getSmartCacheTTL(room);
    const timeSinceUpdate = now - room.lastUpdated;
    
    // Herhangi bir room'un cache'i expire olduysa refresh gerekli
    if (timeSinceUpdate > roomTTL) {
      return false;
    }
  }
  
  return true;
};

// JSON dosyasından veri oku
const readRoomsData = async () => {
  try {
    const data = await fs.readFile(ROOMS_DATA_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('📁 Creating new rooms data file...');
    return {};
  }
};

// JSON dosyasına veri yaz
const writeRoomsData = async (data) => {
  await fs.writeFile(ROOMS_DATA_PATH, JSON.stringify(data, null, 2));
};

// Blockchain'den user rooms çek
const fetchUserRoomsFromBlockchain = async (userAddress) => {
  try {
    console.log(`🔍 Fetching rooms for user: ${userAddress}`);
    
    // User'ın room ID'lerini çek
    const userRoomIds = await publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: OTC_SWAP_MANAGER_ABI,
      functionName: 'getUserRooms',
      args: [userAddress]
    });

    console.log(`📊 User has ${userRoomIds.length} rooms`);

    const userRooms = [];
    const userAddressLower = userAddress.toLowerCase();

    // Her room için detayları çek (batch processing ile) - Rate limit için daha yavaş
    const BATCH_SIZE = config.api.rateLimit.batchSize; // Config'den al
    for (let i = 0; i < userRoomIds.length; i += BATCH_SIZE) {
      const batch = userRoomIds.slice(i, i + BATCH_SIZE);
      
      const batchPromises = batch.map(async (roomIdBigInt) => {
        const roomId = Number(roomIdBigInt);
        
        try {
          // Sequential processing - rate limit'i aşmamak için
          const roomInfo = await publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: OTC_SWAP_MANAGER_ABI,
            functionName: 'getRoom',
            args: [roomIdBigInt]
          });
          
          // Config'den delay
          await new Promise(resolve => setTimeout(resolve, config.api.rateLimit.delayBetweenCalls));
          
          const assets = await publicClient.readContract({
            address: CONTRACT_ADDRESS,
            abi: OTC_SWAP_MANAGER_ABI,
            functionName: 'getRoomAssets',
            args: [roomIdBigInt]
          });

          const [
            maker,
            taker,
            expiry,
            settled,
            cancelled,
            makerDeposited,
            takerDeposited,
            makerClaimed,
            takerClaimed
          ] = roomInfo;

          const [makerAssetsRaw, takerAssetsRaw] = assets;

          const makerLower = maker.toLowerCase();
          const takerLower = taker === '0x0000000000000000000000000000000000000000' 
            ? null 
            : taker.toLowerCase();

          return {
            roomId: roomId.toString(),
            maker: makerLower,
            taker: takerLower,
            expiry: Number(expiry) * 1000,
            settled,
            cancelled,
            makerDeposited,
            takerDeposited,
            makerAssets: makerAssetsRaw.map(asset => {
              const mappedAsset = {
                kind: Number(asset.kind),
                token: asset.token.toLowerCase(),
                id: asset.id.toString(),
                amount: asset.amount.toString()
              };
              
              // MON token için özel bilgiler ekle
              if (Number(asset.kind) === 3 && asset.token === '0x0000000000000000000000000000000000000000') {
                mappedAsset.symbol = 'MON';
                mappedAsset.name = 'Monad Native Token';
                mappedAsset.decimals = 18;
              }
              
              // NFT'ler için collection bilgileri ekle (Multi-Collection)
              if (Number(asset.kind) === 0 || Number(asset.kind) === 1) {
                const collectionName = getCollectionNameByAddress(asset.token);
                mappedAsset.name = getDisplayName(asset.token, parseInt(asset.id));
                mappedAsset.collectionName = collectionName;
                mappedAsset.collectionAddress = asset.token.toLowerCase();
              }
              
              return mappedAsset;
            }),
            takerAssets: takerAssetsRaw.map(asset => {
              const mappedAsset = {
                kind: Number(asset.kind),
                token: asset.token.toLowerCase(),
                id: asset.id.toString(),
                amount: asset.amount.toString()
              };
              
              // MON token için özel bilgiler ekle
              if (Number(asset.kind) === 3 && asset.token === '0x0000000000000000000000000000000000000000') {
                mappedAsset.symbol = 'MON';
                mappedAsset.name = 'Monad Native Token';
                mappedAsset.decimals = 18;
              }
              
              // NFT'ler için collection bilgileri ekle (Multi-Collection)
              if (Number(asset.kind) === 0 || Number(asset.kind) === 1) {
                const collectionName = getCollectionNameByAddress(asset.token);
                mappedAsset.name = getDisplayName(asset.token, parseInt(asset.id));
                mappedAsset.collectionName = collectionName;
                mappedAsset.collectionAddress = asset.token.toLowerCase();
              }
              
              return mappedAsset;
            }),
            status: determineStatus({
              settled,
              cancelled,
              makerDeposited,
              takerDeposited,
              expiry: Number(expiry)
            }),
            userRole: makerLower === userAddressLower ? 'maker' : 'taker',
            lastUpdated: Date.now()
          };
        } catch (error) {
          console.error(`❌ Error fetching room ${roomId}:`, error);
          
          // Rate limit hatası ise daha uzun bekle
          if (error.message && error.message.includes('429')) {
            console.log(`⏳ Rate limit hit for room ${roomId}, waiting 2 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      userRooms.push(...batchResults.filter(room => room !== null));
      
      // Batch'ler arasında delay - Config'den
      if (i + BATCH_SIZE < userRoomIds.length) {
        await new Promise(resolve => setTimeout(resolve, config.api.rateLimit.delayBetweenBatches));
      }
    }

    console.log(`✅ Successfully fetched ${userRooms.length} rooms for user ${userAddress}`);
    return userRooms;
  } catch (error) {
    console.error('❌ Error fetching user rooms from blockchain:', error);
    throw error;
  }
};

// API Endpoints

// GET /api/user-rooms/:address - User'ın room'larını getir
app.get('/api/user-rooms/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { forceRefresh } = req.query;
    
    if (!address) {
      return res.status(400).json({ error: 'User address is required' });
    }

    const roomsData = await readRoomsData();
    const userAddressLower = address.toLowerCase();
    
    // Cache'de veri var mı kontrol et
    const cachedData = roomsData[userAddressLower];
    const shouldRefresh = !isCacheFresh(cachedData, forceRefresh);

    if (shouldRefresh) {
        console.log(`🔄 Refreshing rooms for ${userAddressLower}`);
        
        // Hangi room'ların cache'i expire olduğunu logla
        if (cachedData) {
          const now = Date.now();
          cachedData.rooms.forEach(room => {
            const ttl = getSmartCacheTTL(room);
            const age = now - room.lastUpdated;
            if (age > ttl) {
              console.log(`   🔄 Room ${room.roomId} cache expired: ${room.status}, age: ${Math.round(age/1000)}s > TTL: ${Math.round(ttl/1000)}s`);
            }
          });
        }
        
        try {
          // Kuyruğa ekle
          const freshRooms = await requestQueue.enqueue(
            () => fetchUserRoomsFromBlockchain(address),
            userAddressLower
          );
        
        // Cache'e kaydet - sadece gerçek odalar varsa
        if (freshRooms.length > 0) {
          roomsData[userAddressLower] = {
            rooms: freshRooms,
            lastUpdated: Date.now()
          };
          await writeRoomsData(roomsData);
        } else {
          // Boş array ise cache'den sil
          delete roomsData[userAddressLower];
          await writeRoomsData(roomsData);
        }
        
        res.json({
          rooms: freshRooms,
          cached: false,
          lastUpdated: Date.now()
        });
      } catch (error) {
        // Blockchain hatası varsa cache'den döndür
        if (cachedData) {
          console.log('⚠️ Using cached data due to blockchain error');
          res.json({
            rooms: cachedData.rooms,
            cached: true,
            lastUpdated: cachedData.lastUpdated,
            error: 'Blockchain error, showing cached data'
          });
        } else {
          throw error;
        }
      }
      } else {
        console.log(`📋 Using cached rooms for ${userAddressLower}`);
        
        // Cache bilgilerini logla
        const now = Date.now();
        cachedData.rooms.forEach(room => {
          const ttl = getSmartCacheTTL(room);
          const age = now - room.lastUpdated;
          console.log(`   Room ${room.roomId}: ${room.status}, TTL: ${Math.round(ttl/1000)}s, Age: ${Math.round(age/1000)}s`);
        });
        
        res.json({
          rooms: cachedData.rooms,
          cached: true,
          lastUpdated: cachedData.lastUpdated
        });
      }
  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch user rooms',
      details: error.message 
    });
  }
});

// POST /api/user-rooms/:address/refresh - User'ın room'larını zorla yenile
app.post('/api/user-rooms/:address/refresh', async (req, res) => {
  try {
    const { address } = req.params;
    
    if (!address) {
      return res.status(400).json({ error: 'User address is required' });
    }

    console.log(`🔄 Force refreshing rooms for ${address}`);
    const freshRooms = await requestQueue.enqueue(
      () => fetchUserRoomsFromBlockchain(address),
      address.toLowerCase()
    );
    
    // Cache'e kaydet - sadece gerçek odalar varsa
    const roomsData = await readRoomsData();
    if (freshRooms.length > 0) {
      roomsData[address.toLowerCase()] = {
        rooms: freshRooms,
        lastUpdated: Date.now()
      };
    } else {
      // Boş array ise cache'den sil
      delete roomsData[address.toLowerCase()];
    }
    await writeRoomsData(roomsData);
    
    res.json({
      rooms: freshRooms,
      cached: false,
      lastUpdated: Date.now()
    });
  } catch (error) {
    console.error('❌ Refresh Error:', error);
    res.status(500).json({ 
      error: 'Failed to refresh user rooms',
      details: error.message 
    });
  }
});

// GET /api/history - Tüm swap geçmişini getir
app.get('/api/history', async (req, res) => {
  try {
    const roomsData = await readRoomsData();
    
    // Tüm user'ların room'larını topla ve geçmiş formatına çevir
    const allRooms = [];
    for (const [userAddress, userData] of Object.entries(roomsData)) {
      if (userData.rooms) {
        userData.rooms.forEach(room => {
          allRooms.push({
            id: room.roomId,
            type: room.status === 'completed' ? 'swap_settled' : 
                  room.status === 'cancelled' ? 'room_cancelled' : 'room_created',
            roomId: room.roomId,
            maker: room.maker,
            taker: room.taker,
            expiry: room.expiry,
            status: room.status,
            settled: room.settled,
            cancelled: room.cancelled,
            makerAssets: room.makerAssets,
            takerAssets: room.takerAssets,
            lastUpdated: room.lastUpdated,
            timestamp: new Date(room.lastUpdated).toISOString()
          });
        });
      }
    }
    
    // Tarihe göre sırala (en yeni önce)
    allRooms.sort((a, b) => b.lastUpdated - a.lastUpdated);
    
    res.json(allRooms);
  } catch (error) {
    console.error('❌ Error fetching history:', error);
    res.status(500).json({ 
      error: 'Failed to fetch history',
      details: error.message 
    });
  }
});

// GET /api/collections - Koleksiyon bilgilerini getir
app.get('/api/collections', (req, res) => {
  try {
    const collectionsInfo = config.getEnabledCollections().map(collection => ({
      name: collection.name,
      address: collection.address,
      tokenStart: collection.tokenStart,
      tokenEnd: collection.tokenEnd,
      enabled: collection.enabled,
      totalSupply: collection.tokenEnd - collection.tokenStart + 1
    }));
    
    res.json(collectionsInfo);
  } catch (error) {
    console.error('❌ Error fetching collections:', error);
    res.status(500).json({ 
      error: 'Failed to fetch collections',
      details: error.message 
    });
  }
});

// GET /api/health - Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: Date.now(),
    service: 'user-rooms-api',
    queue: {
      pending: requestQueue.queue.length,
      processing: requestQueue.currentRequests,
      totalProcessed: requestQueue.requestCount,
      recentRequests: requestQueue.getRecentRequestCount(),
      isHighLoad: requestQueue.isHighLoad()
    }
  });
});

// Server başlat
app.listen(config.ports.userRoomsAPI, () => {
  console.log(`🚀 User Rooms API running on port ${config.ports.userRoomsAPI}`);
  console.log(`📡 Endpoints:`);
  console.log(`   GET  /api/user-rooms/:address`);
  console.log(`   GET  /api/history`);
  console.log(`   GET  /api/collections`);
  console.log(`   GET  /api/health`);
});

export default app;
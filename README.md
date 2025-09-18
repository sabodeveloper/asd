# OTC Swap API Services

Monad Testnet üzerindeki OTC Swap uygulaması için API servisleri.

## Servisler

### 1. User Rooms API (Port 3001)
Kullanıcı swap odalarını yöneten API servisi.

**Özellikler:**
- Kullanıcı swap room'larını takip eder
- Akıllı cache sistemi (duruma göre TTL)
- Rate limiting ve queue management
- Real-time room status güncellemeleri

**Endpoints:**
- `GET /api/user-rooms/:address` - Kullanıcının odalarını getir
- `GET /api/history` - Tüm swap geçmişi
- `GET /api/collections` - Koleksiyon bilgileri
- `GET /api/health` - Sistem durumu

### 2. Multi-Collection NFT API (Port 4000)
NFT koleksiyonlarının sahiplik bilgilerini takip eden API servisi.

**Özellikler:**
- Multi-collection support (ERC721 & ERC1155)
- Real-time WebSocket monitoring
- Otomatik sahiplik senkronizasyonu
- Performance için cache sistemi

**Endpoints:**
- `GET /owners` - Tüm koleksiyonlar
- `GET /owners/:collectionName` - Belirli koleksiyon
- `GET /owners/:collectionName/:tokenId` - Belirli token
- `GET /collections` - Koleksiyon bilgileri
- `GET /stats` - İstatistikler

## Desteklenen NFT Koleksiyonları

- **MonBeans**: `0x6aa4872ab4e0fdf078efd17acd45b6352f47c39c` (ERC721)
- **Spikes**: `0x87e1f1824c9356733a25d6bed6b9c87a3b31e107` (ERC721)
- **TheDaks**: `0x78ed9a576519024357ab06d9834266a04c9634b7` (ERC721)
- **SLMNDGenesis**: `0xf7b984c089534ff656097e8c6838b04c5652c947` (ERC1155) - Disabled

## Deployed Contracts

- **OtcSwapManager**: `0xB16Fac906C36de46da4010Fbb19F868Bc2449292`
- **VerifiedRegistry**: `0xcC77804CE6cfb86BF9EE31D45C5e397d6b63853d`
- **Network**: Monad Testnet (Chain ID: 10143)

## Çalıştırma

### User Rooms API
```bash
cd /api
node user-rooms.js
```

### Multi-Collection NFT API
```bash
cd /api/owner-nft
node multi.js
```

## Teknik Detayler

- **Node.js** + **Express.js**
- **Viem** blockchain client
- **WebSocket** real-time monitoring
- **Monad Testnet** RPC endpoints
- **Smart caching** with dynamic TTL
- **Rate limiting** and queue management

## Cache Stratejileri

### User Rooms
- **Final durumlar** (completed/cancelled): 30 dakika
- **Expire olmuş**: 3 dakika
- **Aktif room'lar**: 30 saniye
- **Kritik expire** (5 dk kaldı): 10 saniye

### NFT Ownership
- **Batch processing** with rate limiting
- **Real-time event monitoring**
- **Automatic sync** on startup
- **WebSocket fallback** for reliability

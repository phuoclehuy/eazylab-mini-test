# EAZYLAB MINI TEST - DESIGN DOCUMENT

**Người thực hiện:** [Your Name]  
**Ngày:** 9 Tháng 12, 2025  
**Phần làm:** Core B - Inventory Reservation + Domain Thinking

---

# PHẦN 0: PLUGIN IMPLEMENTATION

> **Lưu ý:** Phần này mô tả cách implement plugin theo chuẩn Vendure

## 0.1. Cấu trúc Plugin

### File structure

```
src/plugins/inventory-reservation/
├── inventory-reservation.plugin.ts    # Main plugin file
├── types.ts                           # Type definitions
├── index.ts                           # Exports
│
├── entities/
│   └── stock-reservation.entity.ts    # Database entity
│
├── services/
│   ├── reservation.service.ts         # Business logic
│   └── reservation-cleanup.service.ts # Background job
│
└── config/
    └── reservation-order-process.ts   # OrderProcess hooks
```

---

## 0.2. Step 1: Tạo Plugin Class

**File:** `inventory-reservation.plugin.ts`

```typescript
import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { StockReservation } from './entities/stock-reservation.entity';
import { ReservationService } from './services/reservation.service';
import { ReservationCleanupService } from './services/reservation-cleanup.service';
import { reservationOrderProcess } from './config/reservation-order-process';

@VendurePlugin({
  // Import PluginCommonModule để access Vendure services
  imports: [PluginCommonModule],
  
  // Đăng ký entities
  entities: [StockReservation],
  
  // Đăng ký services
  providers: [ReservationService, ReservationCleanupService],
  
  // Configure Vendure khi load plugin
  configuration: (config) => {
    // ⭐ Thêm OrderProcess vào config
    config.orderOptions.process.push(reservationOrderProcess);
    
    return config;
  },
})
export class InventoryReservationPlugin {
  private static options: ReservationPluginOptions;
  
  // Static method để init plugin với options
  static init(options: ReservationPluginOptions) {
    this.options = options;
    return this;
  }
  
  static getOptions() {
    return this.options;
  }
}
```

**Key points:**
- `@VendurePlugin()` decorator đăng ký plugin
- `entities`: Vendure tự động tạo tables khi chạy migration
- `providers`: NestJS dependency injection
- `configuration`: Hook để modify Vendure config

---

## 0.3. Step 2: Register Plugin vào Vendure Config

**File:** `vendure-config.ts`

```typescript
import { VendureConfig } from '@vendure/core';
import { defaultEmailHandlers, EmailPlugin } from '@vendure/email-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import path from 'path';

// ⭐ Import plugin
import { InventoryReservationPlugin } from './plugins/inventory-reservation';

export const config: VendureConfig = {
  apiOptions: {
    port: 3000,
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
  },
  
  authOptions: {
    tokenMethod: ['bearer', 'cookie'],
    sessionSecret: process.env.SESSION_SECRET || 'your-secret',
  },
  
  dbConnectionOptions: {
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    username: process.env.DB_USERNAME || 'vendure',
    password: process.env.DB_PASSWORD || 'vendure',
    database: process.env.DB_NAME || 'vendure',
    synchronize: false, // Use migrations in production
    migrations: [path.join(__dirname, 'migrations/*.ts')],
  },
  
  // ⭐ Đăng ký plugins
  plugins: [
    AssetServerPlugin.init({
      route: 'assets',
      assetUploadDir: path.join(__dirname, '../static/assets'),
    }),
    
    EmailPlugin.init({
      devMode: true,
      handlers: defaultEmailHandlers,
    }),
    
    AdminUiPlugin.init({
      route: 'admin',
      port: 3002,
    }),
    
    // ⭐⭐⭐ ĐĂNG KÝ INVENTORY RESERVATION PLUGIN ⭐⭐⭐
    InventoryReservationPlugin.init({
      reservationTTL: 15 * 60 * 1000,      // 15 phút
      cleanupInterval: 60 * 1000,           // 1 phút
      extendOnUpdate: true,                 // Extend TTL khi update cart
      enableDistributedLock: false,         // Redis lock (optional)
      redisConfig: process.env.REDIS_URL ? {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
      } : undefined,
    }),
  ],
};
```

**Key points:**
- Plugin được thêm vào `plugins` array
- Gọi `.init()` để truyền options
- Vendure sẽ load plugins theo thứ tự

---

## 0.4. Step 3: Vendure Load Plugin như thế nào?

### Bootstrap flow:

```
1. Application start
      ↓
2. Vendure reads vendure-config.ts
      ↓
3. For each plugin in config.plugins:
      ↓
   a. Read @VendurePlugin metadata
      ↓
   b. Register entities → TypeORM
      ↓
   c. Register providers → NestJS DI
      ↓
   d. Call configuration() function
      ↓
   e. Merge plugin config into main config
      ↓
4. Initialize NestJS application
      ↓
5. Run database migrations (if needed)
      ↓
6. Call plugin lifecycle hooks:
      ↓
   a. onApplicationBootstrap()
   b. onModuleInit()
      ↓
7. Start GraphQL server
      ↓
8. Plugin ready! ✅
```

### Code execution timeline:

```typescript
// T0: Vendure bootstrap
const app = await bootstrap(config);

// T1: Plugin metadata được đọc
@VendurePlugin({
  entities: [StockReservation],  // → TypeORM registers entity
  providers: [ReservationService] // → NestJS registers provider
})

// T2: configuration() được gọi
configuration: (config) => {
  config.orderOptions.process.push(reservationOrderProcess);
  // ⭐ reservationOrderProcess được thêm vào Vendure config
  return config;
}

// T3: NestJS inject dependencies
class ReservationService {
  constructor(
    private connection: TransactionalConnection,  // ← Vendure cung cấp
    private eventBus: EventBus,                   // ← Vendure cung cấp
  ) {}
}

// T4: Lifecycle hooks
class ReservationCleanupService implements OnApplicationBootstrap {
  async onApplicationBootstrap() {
    // ⭐ Chạy sau khi app khởi động
    this.scheduleCleanup();
  }
}

// T5: OrderProcess.init() được gọi
export const reservationOrderProcess: OrderProcess<OrderState> = {
  init(injector: Injector) {
    // ⭐ Vendure inject ReservationService
    reservationService = injector.get(ReservationService);
  }
}

// T6: Plugin ready, hooks active
// Khi order transition:
OrderStateMachine.transition(order, 'PaymentSettled')
  ↓
reservationOrderProcess.onTransitionEnd(from, to, data)
  ↓
reservationService.confirmReservations(order.id)  // ⭐ Plugin code chạy!
```

---

## 0.5. Step 4: Database Migration

### Generate migration:

```bash
npm run migration:generate -- --name=CreateStockReservationTable
```

Vendure sẽ:
1. Scan `entities` từ tất cả plugins
2. Compare với DB schema hiện tại
3. Generate migration file

### Migration file:

```typescript
import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateStockReservationTable1702123456789 
  implements MigrationInterface {
  
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create table
    await queryRunner.createTable(new Table({
      name: 'stock_reservation',
      columns: [
        { name: 'id', type: 'varchar', isPrimary: true },
        { name: 'createdAt', type: 'timestamp' },
        { name: 'updatedAt', type: 'timestamp' },
        { name: 'productVariantId', type: 'varchar' },
        { name: 'orderId', type: 'varchar' },
        { name: 'stockLocationId', type: 'varchar' },
        { name: 'quantity', type: 'int' },
        { name: 'status', type: 'varchar' },
        { name: 'expiresAt', type: 'timestamp' },
        { name: 'channelId', type: 'varchar', isNullable: true },
        { name: 'metadata', type: 'json', isNullable: true },
      ],
    }));
    
    // Create indexes
    await queryRunner.createIndex('stock_reservation', 
      new TableIndex({
        name: 'idx_variant_location',
        columnNames: ['productVariantId', 'stockLocationId'],
      })
    );
    
    // ... more indexes
  }
  
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('stock_reservation');
  }
}
```

### Run migration:

```bash
npm run migration:run
```

---

## 0.6. Step 5: Plugin Exports

**File:** `index.ts`

```typescript
// Export plugin
export * from './inventory-reservation.plugin';

// Export types (for TypeScript users)
export * from './types';

// Export services (nếu cần extend)
export * from './services/reservation.service';

// Export entities (nếu cần query)
export * from './entities/stock-reservation.entity';
```

**Usage trong other files:**

```typescript
// Other developers có thể import
import { 
  InventoryReservationPlugin,
  ReservationService,
  StockReservation 
} from './plugins/inventory-reservation';
```

---

## 0.7. Plugin Options Type

**File:** `types.ts`

```typescript
export interface ReservationPluginOptions {
  /**
   * Thời gian giữ hàng (milliseconds)
   * @default 900000 (15 minutes)
   */
  reservationTTL?: number;
  
  /**
   * Tần suất cleanup expired reservations (milliseconds)
   * @default 60000 (1 minute)
   */
  cleanupInterval?: number;
  
  /**
   * Extend TTL khi customer update giỏ hàng
   * @default true
   */
  extendOnUpdate?: boolean;
  
  /**
   * Enable distributed lock với Redis (cho multi-server)
   * @default false
   */
  enableDistributedLock?: boolean;
  
  /**
   * Redis config (required nếu enableDistributedLock = true)
   */
  redisConfig?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
}

export enum ReservationStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  RELEASED = 'RELEASED',
}

export class InsufficientStockForReservationError extends Error {
  constructor(
    public readonly availableQuantity: number,
    public readonly requestedQuantity: number,
  ) {
    super(`Only ${availableQuantity} items available, but ${requestedQuantity} requested`);
  }
}
```

---

## 0.8. Tóm tắt Plugin Flow

```
Developer writes plugin code
         ↓
Plugin exports InventoryReservationPlugin class
         ↓
Developer adds to vendure-config.ts:
  plugins: [
    InventoryReservationPlugin.init({ ... })
  ]
         ↓
Vendure starts:
  1. Reads @VendurePlugin metadata
  2. Registers entities (StockReservation)
  3. Registers providers (ReservationService)
  4. Calls configuration() → adds OrderProcess
  5. Injects dependencies
  6. Calls lifecycle hooks (onApplicationBootstrap)
  7. OrderProcess.init() receives injector
         ↓
Plugin active! 🎉
         ↓
Order lifecycle events trigger plugin code:
  - OrderLineEvent → EventBus subscriber
  - Order transition → OrderProcess hooks
  - Background job → Cleanup service
```

---

# PHẦN 1: CORE B - INVENTORY RESERVATION

## 1. Tổng quan thiết kế

### 1.1. Mục tiêu
Xây dựng cơ chế "giữ hàng tạm thời" để tránh overselling khi nhiều khách hàng đồng thời đặt hàng cùng một sản phẩm.

### 1.2. Nguyên tắc thiết kế
- **Tạm giữ** số lượng sản phẩm khi khách thêm vào giỏ hàng
- **Tự động hủy** reservation sau thời gian timeout (15 phút)
- **Chuyển đổi** reservation thành stock allocation khi thanh toán thành công
- **Giải phóng** stock khi đơn hàng bị hủy hoặc timeout
- **Thread-safe** để xử lý concurrent requests

---

## 2. Cách ghi nhận số hàng đang được giữ

### 2.1. Cấu trúc dữ liệu

Tạo một entity mới `StockReservation` để lưu trữ thông tin giữ hàng:

```typescript
StockReservation {
  id: ID
  createdAt: DateTime
  updatedAt: DateTime
  
  // Quan hệ với Vendure entities
  productVariantId: ID        // Link đến ProductVariant
  orderId: ID                 // Link đến Order (giỏ hàng)
  stockLocationId: ID         // Link đến StockLocation
  
  // Thông tin reservation
  quantity: number            // Số lượng đang giữ
  status: enum                // PENDING | CONFIRMED | RELEASED
  expiresAt: DateTime         // Thời điểm hết hạn
  
  // Multi-tenant
  channelId: ID               // Để phân tách giữa các shop
  
  // Metadata
  metadata: JSON              // Lưu thông tin bổ sung
}
```

### 2.2. Indexes để tối ưu query

```sql
CREATE INDEX idx_variant_location ON stock_reservation(productVariantId, stockLocationId);
CREATE INDEX idx_order ON stock_reservation(orderId);
CREATE INDEX idx_expires ON stock_reservation(expiresAt) WHERE status = 'PENDING';
CREATE INDEX idx_channel_status ON stock_reservation(channelId, status);
```

### 2.3. Khi nào tạo reservation?

**Hook point trong Vendure:**

Không dùng trong lifecycle mặc định của Order (vì AddingItems state không có transition event), mà dùng **EventBus** để lắng nghe `OrderLineEvent`:

```typescript
EventBus.subscribe(OrderLineEvent, async (event) => {
  if (event.type === 'created' || event.type === 'updated') {
    // Tạo hoặc update reservation
    await createOrUpdateReservation({
      orderId: event.order.id,
      productVariantId: event.orderLine.productVariantId,
      quantity: event.orderLine.quantity,
      expiresAt: now + 15 minutes
    });
  }
});
```

---

## 3. Chuyển "hàng giữ" → "hàng đã xuất"

### 3.1. Hook vào Order lifecycle

Sử dụng **OrderProcess** của Vendure để hook vào transition events:

```typescript
OrderProcess {
  async onTransitionEnd(fromState, toState, data) {
    if (toState === 'PaymentSettled' || toState === 'PaymentAuthorized') {
      // 1. Confirm tất cả reservations của order
      await confirmReservations(orderId);
      
      // 2. Vendure tự động allocate stock (dùng logic sẵn)
      // StockMovement sẽ được tạo với type = 'ALLOCATION'
    }
  }
}
```

### 3.2. Logic confirm reservation

```typescript
async confirmReservations(orderId) {
  // 1. Find tất cả PENDING reservations
  const reservations = await findReservations({
    orderId,
    status: 'PENDING'
  });
  
  // 2. Update status thành CONFIRMED
  await updateReservations(reservations.map(r => r.id), {
    status: 'CONFIRMED'
  });
  
  // 3. Vendure's OrderService sẽ tự động tạo StockMovement
  // với type='ALLOCATION' khi order transition sang PaymentSettled
}
```

### 3.3. Kết hợp với Vendure stockAllocated

**Vendure đã có sẵn `stockAllocated` field trong ProductVariant:**

```typescript
ProductVariant {
  stockOnHand: number        // Tổng tồn kho
  stockAllocated: number     // Đã allocated cho orders
  stockAvailable: number     // = stockOnHand - stockAllocated
}
```

**Cách kết hợp:**

1. **Reservation là layer bổ sung** trước khi `stockAllocated`:
   - Khi add to cart: Tạo `StockReservation` (PENDING)
   - Khi payment success: Update `StockReservation` (CONFIRMED) + Vendure tạo `stockAllocated`

2. **Tính available stock:**
   ```typescript
   realAvailableStock = stockOnHand 
                       - stockAllocated 
                       - SUM(reservation.quantity WHERE status='PENDING')
   ```

3. **Không duplicate allocation:**
   - `StockReservation.CONFIRMED` chỉ là marker
   - `stockAllocated` vẫn là source of truth cho fulfilled orders
   - Reservation chỉ dùng cho PENDING orders

---

## 4. Giải phóng số hàng khi đơn thất bại hoặc hết hạn

### 4.1. Giải phóng khi order cancelled

**Hook vào OrderProcess:**

```typescript
OrderProcess {
  async onTransitionEnd(fromState, toState, data) {
    if (toState === 'Cancelled') {
      await releaseReservations(orderId);
    }
  }
}
```

### 4.2. Giải phóng khi timeout (Background job)

**Sử dụng JobQueue của Vendure:**

```typescript
@Injectable()
class ReservationCleanupService {
  private cleanupQueue: JobQueue<void>;
  
  async onApplicationBootstrap() {
    // Tạo recurring job chạy mỗi 1 phút
    this.cleanupQueue.add(async () => {
      // 1. Find expired reservations
      const expired = await findReservations({
        status: 'PENDING',
        expiresAt: { $lt: now() }
      });
      
      // 2. Update status thành RELEASED
      await updateReservations(
        expired.map(r => r.id),
        { status: 'RELEASED' }
      );
    }, { repeat: { every: 60000 } }); // Mỗi 60 giây
  }
}
```

### 4.3. Soft delete vs Hard delete

**Chọn Soft delete (update status = RELEASED):**
- ✅ Giữ lại lịch sử cho analytics
- ✅ Debug được khi có vấn đề
- ✅ Track được behavior của khách hàng

**Hard delete sau 30 ngày** để dọn dẹp database.

---

## 5. Ngăn việc bán vượt số lượng khi nhiều người đặt cùng lúc

### 5.1. Race condition scenario

```
Time    User A                  User B                  Stock
----    ------                  ------                  -----
t0      -                       -                       10
t1      Read stock: 10          -                       10
t2      Check: 10 >= 5 ✓        Read stock: 10          10
t3      Reserve 5               Check: 10 >= 7 ✓        10
t4      Write: stock = 5        Reserve 7               10
t5      -                       Write: stock = 3        3
                                                        ❌ Oversold!
```

### 5.2. Giải pháp: Pessimistic Locking

**Sử dụng database row locking (PostgreSQL):**

```typescript
async createOrUpdateReservation(ctx, data) {
  // Bắt đầu transaction
  return await this.connection.rawConnection.transaction(async (transactionalEntityManager) => {
    
    // 1. LOCK variant row để ngăn concurrent reads
    const variant = await transactionalEntityManager
      .createQueryBuilder(ProductVariant, 'variant')
      .where('variant.id = :id', { id: data.productVariantId })
      .setLock('pessimistic_write')  // ⭐ KEY: SELECT ... FOR UPDATE
      .getOne();
    
    // 2. Tính available stock (bao gồm reserved)
    const existingReservations = await transactionalEntityManager
      .createQueryBuilder(StockReservation, 'res')
      .where('res.productVariantId = :variantId', { variantId: variant.id })
      .andWhere('res.status = :status', { status: 'PENDING' })
      .getMany();
    
    const totalReserved = existingReservations
      .reduce((sum, r) => sum + r.quantity, 0);
    
    const available = variant.stockOnHand 
                    - variant.stockAllocated 
                    - totalReserved;
    
    // 3. Validate stock availability
    if (available < data.quantity) {
      throw new InsufficientStockError(available);
    }
    
    // 4. Create/update reservation
    const reservation = transactionalEntityManager.create(StockReservation, {
      ...data,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    });
    
    await transactionalEntityManager.save(reservation);
    
    // Transaction commit → release lock
  });
}
```

### 5.3. Lợi ích của Pessimistic Locking

- ✅ **Đảm bảo consistency**: Chỉ 1 transaction được read/write tại 1 thời điểm
- ✅ **Không cần retry logic**: Blocking đến khi lock được giải phóng
- ✅ **Native database support**: PostgreSQL hỗ trợ sẵn

### 5.4. Xử lý multi-server (distributed system)

**Vấn đề:** Pessimistic locking chỉ work trong 1 database connection pool.

**Giải pháp:** Thêm **distributed lock** với Redis:

```typescript
async createOrUpdateReservation(ctx, data) {
  const lockKey = `variant:${data.productVariantId}`;
  
  // 1. Acquire distributed lock (Redis)
  const lock = await redisClient.acquireLock(lockKey, {
    ttl: 5000,  // 5 giây timeout
    retries: 3
  });
  
  try {
    // 2. Execute business logic (đã có pessimistic lock trong DB)
    await this.executeReservationLogic(ctx, data);
  } finally {
    // 3. Release lock
    await lock.release();
  }
}
```

---

## 6. Ví dụ minh họa

### Scenario 1: Mua hàng thành công

**Initial state:**
- Product Variant "iPhone 15 Pro - 256GB": `stockOnHand = 10`
- `stockAllocated = 0`
- Active reservations: 0

**Timeline:**

```
T0: Khách A thêm 2 iPhone vào giỏ
    → StockReservation created:
       - orderId: order-123
       - productVariantId: iphone-15-pro-256gb
       - quantity: 2
       - status: PENDING
       - expiresAt: T0 + 15 phút
    → Available stock: 10 - 0 - 2 = 8

T1: Khách B thêm 3 iPhone vào giỏ
    → Lock variant row (pessimistic lock)
    → Check: 10 - 0 - 2 = 8 >= 3 ✓
    → Create reservation: quantity = 3
    → Available stock: 10 - 0 - 5 = 5

T5: Khách A thanh toán thành công
    → Order transitions: AddingItems → ArrangingPayment → PaymentSettled
    → OrderProcess.onTransitionEnd triggered
    → Update reservation: status = CONFIRMED
    → Vendure creates StockMovement (type = ALLOCATION)
    → stockAllocated = 2
    → Available stock: 10 - 2 - 3 = 5

T10: Khách B hủy đơn
    → Order transitions: ArrangingPayment → Cancelled
    → OrderProcess.onTransitionEnd triggered
    → Update reservation: status = RELEASED
    → Available stock: 10 - 2 - 0 = 8
```

**Final state:**
- `stockOnHand = 10`
- `stockAllocated = 2` (khách A đã mua)
- Active reservations: 0
- Available: 8

---

### Scenario 2: Race condition với 2 khách mua cùng lúc

**Initial state:**
- Product "MacBook Pro": `stockOnHand = 1` (chỉ còn 1 cái!)

**Timeline:**

```
T0.000: Khách A click "Add to cart" (quantity = 1)
        → Request sent to server

T0.001: Khách B click "Add to cart" (quantity = 1)
        → Request sent to server

T0.010: Server A process request A
        → BEGIN TRANSACTION
        → SELECT * FROM product_variant WHERE id = 'macbook-pro' FOR UPDATE
        → 🔒 ROW LOCKED
        → Check: 1 - 0 - 0 = 1 >= 1 ✓
        → Create reservation (quantity = 1)
        → COMMIT
        → 🔓 ROW UNLOCKED
        → Response: "Added to cart successfully"

T0.011: Server B process request B
        → BEGIN TRANSACTION
        → SELECT * FROM product_variant WHERE id = 'macbook-pro' FOR UPDATE
        → ⏳ WAITING for lock (vì A đang hold lock)

T0.015: Lock released (A committed)
        → Server B acquired lock
        → Check: 1 - 0 - 1 = 0 >= 1 ❌ FAIL
        → ROLLBACK
        → Response: "Only 0 items available"

```

**Kết quả:**
- ✅ Chỉ khách A được giữ hàng
- ✅ Khách B nhận error message: "Sản phẩm đã hết hàng"
- ✅ Không bị overselling

---

## 7. Kết hợp với Vendure stockAllocated

### 7.1. Relationship giữa Reservation và Allocation

```
Reservation (Temporary)     →     Allocation (Permanent)
─────────────────────────         ─────────────────────
StockReservation table              Vendure's stockAllocated
status = PENDING                    Updated when order fulfilled
TTL = 15 minutes                    Permanent until cancelled
For cart items                      For confirmed orders
```

### 7.2. Flow diagram

```
Customer adds to cart
       ↓
   [RESERVATION]
   StockReservation
   status = PENDING
   expiresAt = now + 15min
       ↓
Available = stockOnHand - stockAllocated - SUM(pending_reservations)
       ↓
   [2 paths]
       ↓                           ↓
   Payment Success            Timeout/Cancel
       ↓                           ↓
   [ALLOCATION]              [RELEASE]
   Reservation.CONFIRMED     Reservation.RELEASED
   stockAllocated++          (giải phóng)
       ↓                           ↓
   Order fulfilled           Stock available lại
```

### 7.3. Query để tính available stock

```typescript
async getAvailableStock(variantId: string, locationId: string) {
  // 1. Get variant info
  const variant = await this.productVariantService.findOne(variantId);
  
  // 2. Get stock level
  const stockLevel = await this.stockLocationService
    .getStockLevel(variantId, locationId);
  
  // 3. Sum pending reservations
  const pendingReservations = await this.reservationRepository
    .createQueryBuilder('res')
    .select('SUM(res.quantity)', 'total')
    .where('res.productVariantId = :variantId', { variantId })
    .andWhere('res.stockLocationId = :locationId', { locationId })
    .andWhere('res.status = :status', { status: 'PENDING' })
    .getRawOne();
  
  const reserved = pendingReservations?.total || 0;
  
  // 4. Calculate available
  return {
    stockOnHand: stockLevel.stockOnHand,
    stockAllocated: stockLevel.stockAllocated,
    stockReserved: reserved,
    availableForSale: stockLevel.stockOnHand 
                     - stockLevel.stockAllocated 
                     - reserved
  };
}
```

---

# PHẦN 2: DOMAIN THINKING

## 1. Plugin Architecture - Fit với Vendure

### 1.1. Hook vào giai đoạn nào của lifecycle đơn hàng?

**3 hook points chính:**

#### A. EventBus - Khi thêm/sửa giỏ hàng

```typescript
@Injectable()
class ReservationEventSubscriber {
  constructor(private eventBus: EventBus) {}
  
  onModuleInit() {
    // Hook vào OrderLineEvent
    this.eventBus.ofType(OrderLineEvent).subscribe(event => {
      if (event.type === 'created' || event.type === 'updated') {
        // CREATE/UPDATE reservation
      }
      if (event.type === 'deleted') {
        // RELEASE reservation
      }
    });
  }
}
```

**Timing:** Real-time khi khách hàng thao tác với giỏ hàng.

#### B. OrderProcess - Khi order thay đổi trạng thái

```typescript
OrderProcess {
  onTransitionStart(from, to, data) {
    // VALIDATE trước khi transition
    if (to === 'ArrangingPayment') {
      // Check reservation chưa expired
    }
  },
  
  onTransitionEnd(from, to, data) {
    // EXECUTE sau khi transition
    if (to === 'PaymentSettled') {
      // CONFIRM reservations
    }
    if (to === 'Cancelled') {
      // RELEASE reservations
    }
  }
}
```

**Timing:** Khi order chuyển state (ArrangingPayment, PaymentSettled, Cancelled...).

#### C. JobQueue - Background cleanup

```typescript
@Injectable()
class ReservationCleanupService {
  scheduleCleanup() {
    this.jobQueue.add(
      () => this.cleanupExpired(),
      { repeat: { every: 60000 } }  // Mỗi phút
    );
  }
}
```

**Timing:** Periodic job chạy background.

---

### 1.2. Lưu dữ liệu ở đâu?

**Chọn: Entity mới (StockReservation)**

So sánh các options:

| Option | Ưu điểm | Nhược điểm | Đánh giá |
|--------|---------|------------|----------|
| **Custom Fields** (Order.customFields) | Đơn giản, không cần migration | Không query được hiệu quả, không index | ❌ Không phù hợp |
| **Order Line metadata** | Gắn trực tiếp với OrderLine | Khó query theo variant, không track history | ❌ Không phù hợp |
| **Entity mới** | Flexible, có index, query hiệu quả | Phức tạp hơn, cần migration | ✅ **CHỌN** |

**Lý do chọn Entity mới:**
- ✅ Cần query: "Tổng reserved của variant X là bao nhiêu?"
- ✅ Cần index: Optimize query theo variant, location, expiry
- ✅ Cần history: Track được reservation lifecycle
- ✅ Cần relationship: Link tới ProductVariant, Order, StockLocation

---

### 1.3. Dùng Event hay mở rộng Service core?

**Chọn: Hybrid approach**

#### Dùng Event (EventBus) cho:
- ✅ **Add to cart**: Subscribe OrderLineEvent
- ✅ **Loosely coupled**: Không modify Vendure core services
- ✅ **Async processing**: Không block main flow

#### Extend Service cho:
- ✅ **StockLevelService**: Override `getAvailableStock()` để tính cả reserved
- ✅ **OrderService**: Wrap `addItemToOrder()` để validate reservation

```typescript
// Extend StockLevelService
@Injectable()
class ExtendedStockLevelService extends StockLevelService {
  async getAvailableStock(variantId, locationId) {
    const baseStock = await super.getAvailableStock(variantId, locationId);
    const reserved = await this.getReservedQuantity(variantId, locationId);
    
    return baseStock - reserved;  // ⭐ Trừ cả reserved
  }
}
```

---

### 1.4. Làm thế nào plugin không phá logic sẵn có của Vendure?

**4 nguyên tắc:**

#### A. Không modify core tables
- ❌ KHÔNG thêm column vào `product_variant`
- ✅ Tạo table mới `stock_reservation`

#### B. Respect Vendure's order lifecycle
- ✅ Dùng OrderProcess (official API)
- ❌ KHÔNG bypass OrderStateMachine

#### C. Preserve stockAllocated behavior
- ✅ `stockAllocated` vẫn là source of truth
- ✅ Reservation chỉ là layer bổ sung cho pending orders

#### D. Use Vendure's infrastructure
- ✅ Dùng TransactionalConnection
- ✅ Dùng EventBus
- ✅ Dùng JobQueue
- ❌ KHÔNG tự tạo database pool riêng

**Testing strategy:**
```typescript
// Verify không phá Vendure behavior
test('Order without reservation still works', () => {
  // Disable plugin
  const order = await orderService.create(...);
  
  // Should work như bình thường
  expect(order.state).toBe('AddingItems');
});
```

---

## 2. Vấn đề khi Scale Vendure

### 2.1. Database Bottlenecks

#### Vấn đề 1: Query chậm khi nhiều shop

**Hiện tượng:**
```sql
-- Query này sẽ chậm khi có 1000+ shops
SELECT * FROM product_variant 
WHERE channelId IN (shop1, shop2, ..., shop1000)
```

**Nguyên nhân:**
- Single database cho tất cả tenants
- Index không hiệu quả với multi-tenant queries
- N+1 query problem khi load relations

**Giải pháp:**

**A. Database Partitioning theo channelId**
```sql
-- Partition table theo channel
CREATE TABLE product_variant_shop1 PARTITION OF product_variant
  FOR VALUES IN ('channel-shop1');

CREATE TABLE product_variant_shop2 PARTITION OF product_variant
  FOR VALUES IN ('channel-shop2');
```

**Lợi ích:**
- Query chỉ scan 1 partition
- Index nhỏ hơn, nhanh hơn
- Có thể shard sang database khác

**B. Read Replica cho query nặng**
```
[Master DB]  ← Write operations
     ↓
 Replication
     ↓
[Replica 1]  ← Read operations (shop queries)
[Replica 2]  ← Read operations (admin dashboard)
[Replica 3]  ← Read operations (analytics)
```

**C. Composite Index theo channel**
```sql
CREATE INDEX idx_channel_variant 
  ON product_variant(channelId, id);

CREATE INDEX idx_channel_stock 
  ON stock_reservation(channelId, productVariantId, status);
```

---

#### Vấn đề 2: Stock reservation table quá lớn

**Hiện tượng:**
- 1000 shops × 1000 reservations/day = 1M rows/day
- Sau 1 năm: 365M rows
- Query `SUM(quantity) WHERE status='PENDING'` rất chậm

**Giải pháp:**

**A. Partitioning theo thời gian**
```sql
CREATE TABLE stock_reservation (
  ...
) PARTITION BY RANGE (createdAt);

CREATE TABLE stock_reservation_2024_12 
  PARTITION OF stock_reservation
  FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');
```

**B. Archive old data**
```typescript
// Cron job mỗi ngày
async archiveOldReservations() {
  // Move RELEASED/CONFIRMED > 30 days sang archive table
  await db.query(`
    INSERT INTO stock_reservation_archive
    SELECT * FROM stock_reservation
    WHERE status IN ('RELEASED', 'CONFIRMED')
      AND createdAt < NOW() - INTERVAL '30 days'
  `);
  
  await db.query(`DELETE FROM stock_reservation ...`);
}
```

**C. Materialized View cho stats**
```sql
CREATE MATERIALIZED VIEW reservation_stats AS
SELECT 
  productVariantId,
  stockLocationId,
  channelId,
  SUM(quantity) as total_reserved
FROM stock_reservation
WHERE status = 'PENDING'
GROUP BY productVariantId, stockLocationId, channelId;

-- Refresh mỗi 5 phút
REFRESH MATERIALIZED VIEW CONCURRENTLY reservation_stats;
```

---

### 2.2. Order Processing Bottlenecks

#### Vấn đề: Event processing bị nghẽn

**Hiện tượng:**
- Flash sale: 10,000 orders trong 1 phút
- EventBus subscriber xử lý tuần tự → delay
- Reservation tạo chậm → race condition tăng

**Giải pháp:**

**A. Queue-based Event Processing**
```typescript
// Thay vì EventBus synchronous
EventBus.subscribe(OrderLineEvent, async (event) => {
  // Đẩy vào queue thay vì xử lý ngay
  await this.reservationQueue.add({
    type: 'CREATE_RESERVATION',
    data: event
  });
});

// Worker xử lý parallel
@Processor('reservation-queue')
class ReservationWorker {
  @Process('CREATE_RESERVATION')
  async handleCreate(job: Job) {
    await this.reservationService.create(job.data);
  }
}
```

**Config Bull queue:**
```typescript
Queue.config({
  concurrency: 10,  // 10 workers parallel
  limiter: {
    max: 100,      // 100 jobs
    duration: 1000  // per second
  }
});
```

**B. Batch Processing**
```typescript
// Thay vì tạo từng reservation
// → Batch insert mỗi 100ms

class ReservationBatcher {
  private batch: Reservation[] = [];
  private timer: NodeJS.Timeout;
  
  add(reservation: Reservation) {
    this.batch.push(reservation);
    
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 100);
    }
  }
  
  async flush() {
    if (this.batch.length > 0) {
      await this.repository.insert(this.batch);  // Bulk insert
      this.batch = [];
    }
    this.timer = null;
  }
}
```

---

### 2.3. Stock Sync Issues ở Multi-node

#### Vấn đề: Distributed lock với Redis

**Hiện tượng:**
- 3 servers chạy Vendure
- Pessimistic lock trong DB chỉ work trong 1 connection
- 2 servers khác nhau vẫn có thể oversell

**Giải pháp:**

**Distributed Lock với Redlock**
```typescript
import Redlock from 'redlock';

class ReservationService {
  private redlock = new Redlock([redis1, redis2, redis3]);
  
  async createReservation(data) {
    const lockKey = `variant:${data.variantId}:lock`;
    
    // Acquire lock trên 3 Redis nodes
    const lock = await this.redlock.acquire([lockKey], 5000);
    
    try {
      // Business logic với pessimistic DB lock
      await this.db.transaction(async (em) => {
        const variant = await em.findOne(ProductVariant, {
          where: { id: data.variantId },
          lock: { mode: 'pessimistic_write' }
        });
        
        // ... create reservation
      });
    } finally {
      await lock.release();
    }
  }
}
```

**Tại sao cần cả Redlock VÀ Database lock?**
- **Redlock**: Serialize requests giữa multiple servers
- **DB lock**: Ensure consistency trong database

---

### 2.4. Phiên bản Vendure - Hạn chế về Scale

**Vendure 2.x limitations:**

| Aspect | Limitation | Impact |
|--------|-----------|--------|
| **Multi-tenancy** | Shared database | Một tenant chậm → ảnh hưởng tất cả |
| **GraphQL Schema** | Single schema | Không customize per tenant |
| **Worker** | Single instance | Bottleneck khi nhiều background jobs |
| **Event Bus** | In-memory | Không work với multi-server (cần external) |
| **Cache** | In-memory | Không share giữa servers |

**Cần cân nhắc:**
- ✅ Vendure phù hợp cho: 100-500 shops mid-size
- ⚠️ Cần customize khi: 1000+ shops hoặc high-traffic shops
- ❌ Không phù hợp cho: Amazon-scale marketplace

---

## 3. Cách Scale EazyShop trên nền Vendure

### 3.1. Khi nào tách thành Microservices?

**Timing triggers:**

| Metric | Threshold | Action |
|--------|-----------|--------|
| **Database CPU** | > 70% sustained | Tách read/write |
| **Request latency** | P95 > 1s | Tách services |
| **Order volume** | > 10,000/hour | Tách order service |
| **Number of shops** | > 1,000 | Shard database |

**Decision tree:**
```
Database CPU > 70%?
    ↓ YES
Có thể optimize query?
    ↓ NO
Có thể add read replica?
    ↓ NO
→ TÁCH MICROSERVICES
```

---

### 3.2. Module nào cần tách trước?

**Priority order:**

#### Phase 1: Tách Inventory Service (PRIORITY 1)

**Lý do:**
- ✅ High write volume (reservation, allocation)
- ✅ Cần optimize riêng (caching, locking)
- ✅ Ít dependency với modules khác
- ✅ Có thể shard theo warehouse

**Architecture:**
```
┌─────────────────┐
│  Vendure Core   │
│  (Catalog, Cart)│
└────────┬────────┘
         │ gRPC/REST
         ↓
┌─────────────────┐     ┌──────────────┐
│ Inventory API   │────→│  Redis Cache │
│  - Reservation  │     └──────────────┘
│  - Allocation   │
│  - Stock Check  │     ┌──────────────┐
└────────┬────────┘────→│  PostgreSQL  │
         │               │  (Inventory) │
         │               └──────────────┘
         │ Events
         ↓
┌─────────────────┐
│  Event Bus      │
│  (Kafka/NATS)   │
└─────────────────┘
```

#### Phase 2: Tách Order Processing Service (PRIORITY 2)

**Lý do:**
- ✅ CPU-intensive (payment, fulfillment)
- ✅ Cần scale độc lập khi flash sale
- ✅ Có nhiều external integrations (payment gateway, shipping)

**Architecture:**
```
┌─────────────────┐
│  Vendure Core   │
└────────┬────────┘
         │ Event
         ↓
┌─────────────────┐     ┌──────────────┐
│ Order Processor │────→│ Payment API  │
│  - Validation   │     └──────────────┘
│  - Payment      │
│  - Fulfillment  │     ┌──────────────┐
└────────┬────────┘────→│ Shipping API │
         │               └──────────────┘
         │ Queue
         ↓
┌─────────────────┐
│   Bull Queue    │
│   (Redis)       │
└─────────────────┘
```

#### Phase 3: Tách Search Service (PRIORITY 3)

**Lý do:**
- ✅ Read-heavy
- ✅ Cần full-text search (Elasticsearch)
- ✅ Tách ra không ảnh hưởng core

#### Phase 4: Tách Analytics Service (PRIORITY 4)

**Lý do:**
- ✅ Separate database (OLAP)
- ✅ Không cần real-time
- ✅ Heavy aggregation queries

---

### 3.3. Cách giảm tải Database

**4-tier strategy:**

#### Tier 1: Query Optimization (Week 1-2)

```sql
-- Before: Slow query
SELECT * FROM order_line
WHERE orderId IN (
  SELECT id FROM order WHERE customerId = 123
);

-- After: Join with index
SELECT ol.* FROM order_line ol
INNER JOIN order o ON ol.orderId = o.id
WHERE o.customerId = 123
  AND o.channelId = 'shop1';  -- ⭐ Add channel filter

-- Add index
CREATE INDEX idx_order_customer_channel 
  ON order(customerId, channelId, id);
```

#### Tier 2: Read Replica (Week 3-4)

```typescript
// Vendure config
VendureConfig {
  dbConnectionOptions: {
    // Master cho write
    master: {
      host: 'master-db.example.com',
    },
    // Replicas cho read
    slaves: [
      { host: 'replica-1.example.com' },
      { host: 'replica-2.example.com' },
    ],
    // TypeORM tự động route
  }
}
```

#### Tier 3: Caching (Week 5-6)

**3-layer cache:**

```typescript
// L1: In-memory (Node.js)
const L1Cache = new LRU({ max: 1000, ttl: 60000 });

// L2: Redis (shared across servers)
const L2Cache = new Redis();

// L3: CDN (static content)
const CDN = 'https://cdn.eazyshop.com';

async getProduct(id) {
  // L1 check
  let product = L1Cache.get(id);
  if (product) return product;
  
  // L2 check
  product = await L2Cache.get(`product:${id}`);
  if (product) {
    L1Cache.set(id, product);
    return product;
  }
  
  // L3: Database
  product = await db.findOne(Product, id);
  L2Cache.set(`product:${id}`, product, 'EX', 3600);
  L1Cache.set(id, product);
  
  return product;
}
```

**Cache invalidation:**
```typescript
EventBus.subscribe(ProductEvent, async (event) => {
  if (event.type === 'updated') {
    // Invalidate all cache layers
    L1Cache.delete(event.product.id);
    await L2Cache.del(`product:${event.product.id}`);
    await CDN.purge(`/products/${event.product.id}`);
  }
});
```

#### Tier 4: Database Sharding (Month 3+)

**Shard strategy: Theo channelId (shop)**

```
┌──────────────────┐
│  API Gateway     │
└────────┬─────────┘
         │
    ┌────┴────┐
    │ Router  │ ← Determine shard by channelId
    └────┬────┘
         │
    ┌────┼────┐
    ↓    ↓    ↓
[Shard 1] [Shard 2] [Shard 3]
 Shop     Shop      Shop
 1-333    334-666   667-1000
```

**Implementation:**
```typescript
class ShardRouter {
  private shards = {
    shard1: { min: 1, max: 333, db: 'shard1-db' },
    shard2: { min: 334, max: 666, db: 'shard2-db' },
    shard3: { min: 667, max: 1000, db: 'shard3-db' },
  };
  
  getConnection(channelId: string) {
    const shopNumber = this.extractShopNumber(channelId);
    
    for (const [name, shard] of Object.entries(this.shards)) {
      if (shopNumber >= shard.min && shopNumber <= shard.max) {
        return this.connections[shard.db];
      }
    }
  }
}
```

---

### 3.4. Cân bằng Consistency vs Performance

**Trade-off analysis:**

| Scenario | Consistency Need | Performance Need | Solution |
|----------|-----------------|------------------|----------|
| **Stock check** | HIGH (no overselling) | MEDIUM | Strong consistency + cache (5s TTL) |
| **Product catalog** | LOW (eventual OK) | HIGH | Eventual consistency + CDN |
| **Order payment** | CRITICAL | LOW | Synchronous + 2PC |
| **Reservation cleanup** | MEDIUM | HIGH | Async + eventual |

**Implementation patterns:**

#### Pattern 1: Cache-Aside với Eventual Consistency

```typescript
// Product catalog - eventual consistency OK
async getProduct(id) {
  // Try cache first (5 min TTL)
  const cached = await redis.get(`product:${id}`);
  if (cached) return cached;
  
  // DB read
  const product = await db.findOne(Product, id);
  
  // Cache async (không block response)
  redis.set(`product:${id}`, product, 'EX', 300).catch(err => {
    logger.error('Cache write failed', err);
  });
  
  return product;
}
```

#### Pattern 2: Write-Through với Strong Consistency

```typescript
// Stock reservation - strong consistency required
async createReservation(data) {
  return await db.transaction(async (em) => {
    // 1. Pessimistic lock
    const variant = await em.findOne(ProductVariant, {
      where: { id: data.variantId },
      lock: { mode: 'pessimistic_write' }
    });
    
    // 2. Validate stock
    const available = await this.calculateAvailable(variant);
    if (available < data.quantity) {
      throw new InsufficientStockError();
    }
    
    // 3. Create reservation
    const reservation = await em.save(StockReservation, data);
    
    // 4. Invalidate cache AFTER commit
    await this.invalidateCache(data.variantId);
    
    return reservation;
  });
}
```

#### Pattern 3: Saga Pattern cho Distributed Transactions

```typescript
// Order processing across services
class OrderSaga {
  async execute(order) {
    const saga = {
      steps: [
        this.reserveInventory,
        this.processPayment,
        this.createShipment,
      ],
      compensations: [
        this.releaseInventory,
        this.refundPayment,
        this.cancelShipment,
      ]
    };
    
    for (let i = 0; i < saga.steps.length; i++) {
      try {
        await saga.steps[i](order);
      } catch (error) {
        // Rollback: execute compensations in reverse
        for (let j = i; j >= 0; j--) {
          await saga.compensations[j](order);
        }
        throw error;
      }
    }
  }
}
```

---

### 3.5. Quản lý Multi-channel để tránh N+1 Queries

**Problem: N+1 Query Hell**

```typescript
// ❌ BAD: N+1 queries
const orders = await orderRepository.find({ take: 100 });

for (const order of orders) {
  // Query 1: Get order lines
  const lines = await orderLineRepository.find({ orderId: order.id });
  
  for (const line of lines) {
    // Query 2: Get product variant
    const variant = await variantRepository.findOne(line.variantId);
    
    // Query 3: Get stock level
    const stock = await stockRepository.findOne({
      variantId: variant.id,
      locationId: order.shippingLocationId
    });
  }
}

// Total queries: 1 + 100 + (100 × 5) + (100 × 5 × 1) = 1101 queries! 😱
```

**Solution 1: DataLoader Pattern**

```typescript
class ProductVariantLoader {
  private loader = new DataLoader<string, ProductVariant>(
    async (ids: string[]) => {
      // Batch load all variants in 1 query
      const variants = await this.repository
        .createQueryBuilder('variant')
        .whereInIds(ids)
        .getMany();
      
      // Return in same order as input
      return ids.map(id => 
        variants.find(v => v.id === id)
      );
    },
    { cache: true }  // Cache per request
  );
  
  load(id: string) {
    return this.loader.load(id);
  }
}

// Usage
for (const line of lines) {
  // Batched automatically
  const variant = await variantLoader.load(line.variantId);
}
// Only 1 query for all variants!
```

**Solution 2: Eager Loading với Relations**

```typescript
// ✅ GOOD: Eager load everything
const orders = await orderRepository.find({
  relations: [
    'lines',
    'lines.productVariant',
    'lines.productVariant.stockLevels',
  ],
  where: { channelId: 'shop1' },
  take: 100,
});

// Only 1 query with JOINs!
```

**Solution 3: Denormalization cho Multi-channel**

```typescript
// Thay vì query relations mỗi lần
// → Store snapshot trong order_line

OrderLine {
  id: string;
  orderId: string;
  productVariantId: string;
  
  // ⭐ Denormalized data (snapshot at order time)
  productSnapshot: {
    name: string;
    sku: string;
    price: number;
    imageUrl: string;
  };
  
  stockSnapshot: {
    locationId: string;
    locationName: string;
    stockOnHand: number;
  };
}

// Query orders không cần JOIN products!
const orders = await orderRepository.find({ channelId: 'shop1' });
// Data đã có sẵn trong orderLine.productSnapshot
```

---

## 4. Kiến trúc mẫu cho tương lai

### 4.1. Target Architecture (6-12 tháng)

```
                    ┌──────────────────┐
                    │   API Gateway    │
                    │   (Kong/Nginx)   │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            ↓                ↓                ↓
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   Vendure    │  │  Inventory   │  │    Order     │
    │    Core      │  │   Service    │  │  Processing  │
    │              │  │              │  │   Service    │
    │ - Catalog    │  │ - Reservation│  │ - Payment    │
    │ - Cart       │  │ - Stock      │  │ - Fulfillment│
    │ - Customer   │  │ - Allocation │  │ - Shipping   │
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                  │                  │
           └──────────────────┼──────────────────┘
                              ↓
                    ┌──────────────────┐
                    │    Event Bus     │
                    │  (Kafka/NATS)    │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            ↓                ↓                ↓
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │   Search     │  │  Analytics   │  │   Webhook    │
    │  (Elastic)   │  │  (ClickHouse)│  │   Worker     │
    └──────────────┘  └──────────────┘  └──────────────┘

         Caching Layer
    ┌──────────────────────────────────────────┐
    │  Redis Cluster (Multi-layer Cache)       │
    └──────────────────────────────────────────┘

         Database Layer
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │  PostgreSQL  │  │  PostgreSQL  │  │  PostgreSQL  │
    │   (Catalog)  │  │ (Inventory)  │  │   (Orders)   │
    │  + Replicas  │  │  + Replicas  │  │  + Replicas  │
    └──────────────┘  └──────────────┘  └──────────────┘
```

### 4.2. Service Breakdown

#### Service 1: Vendure Core (Lightweight)

**Responsibilities:**
- ✅ Product catalog management
- ✅ Cart management (stateless)
- ✅ Customer management
- ✅ GraphQL API gateway

**Tech Stack:**
- Vendure 2.x
- PostgreSQL (catalog DB)
- Redis (session cache)

**Scaling:**
- Horizontal: 5-10 instances
- Stateless design
- Load balanced

---

#### Service 2: Inventory Service (CRITICAL)

**Responsibilities:**
- ✅ Stock reservation
- ✅ Stock allocation
- ✅ Available stock calculation
- ✅ Warehouse management

**Tech Stack:**
- NestJS (hoặc Go cho performance)
- PostgreSQL (sharded by warehouse)
- Redis (distributed lock)

**API:**
```graphql
type InventoryService {
  # Reserve stock for order
  reserveStock(input: ReserveStockInput!): Reservation!
  
  # Get available stock (với cache)
  getAvailableStock(variantId: ID!, locationId: ID!): StockLevel!
  
  # Confirm reservation (on payment success)
  confirmReservation(orderId: ID!): Boolean!
  
  # Release reservation (on cancel/timeout)
  releaseReservation(orderId: ID!): Boolean!
}
```

**Scaling:**
- Horizontal: 10-20 instances
- Database sharding by warehouse
- Redis cluster for distributed lock

---

#### Service 3: Order Processing Service

**Responsibilities:**
- ✅ Order validation
- ✅ Payment processing
- ✅ Order fulfillment
- ✅ Shipping integration

**Tech Stack:**
- NestJS
- Bull (queue)
- PostgreSQL (orders DB)

**Event-driven flow:**
```
Order Created
    ↓
[Validate] → Check inventory
    ↓
[Process Payment] → Call payment gateway
    ↓
[Confirm Inventory] → Call inventory service
    ↓
[Create Fulfillment] → Call shipping API
    ↓
[Send Notifications] → Email/SMS
    ↓
Order Complete
```

**Scaling:**
- Queue workers: 20-50 workers
- Retry logic với exponential backoff
- Dead letter queue for failed jobs

---

#### Service 4: Webhook Queue Service

**Problem:** Flash sale → 10,000 webhooks/min → overload

**Solution:**
```
Order Event
    ↓
[Webhook Queue]
    ↓
Rate Limiter (100 req/s per endpoint)
    ↓
[Workers Pool] (20 workers)
    ↓
External Webhook Endpoints
```

**Implementation:**
```typescript
@Processor('webhook-queue')
class WebhookWorker {
  @Process({ name: 'send-webhook', concurrency: 20 })
  async sendWebhook(job: Job) {
    const { url, payload, retryCount } = job.data;
    
    try {
      await axios.post(url, payload, {
        timeout: 5000,
        headers: { 'X-Webhook-Signature': this.sign(payload) }
      });
    } catch (error) {
      if (retryCount < 3) {
        // Retry với exponential backoff
        await job.retry({ delay: Math.pow(2, retryCount) * 1000 });
      } else {
        // Move to dead letter queue
        await this.dlq.add('failed-webhook', { url, payload, error });
      }
    }
  }
}
```

---

### 4.3. Event-Driven Architecture với Kafka

**Why Kafka?**
- ✅ High throughput (1M msg/s)
- ✅ Durable (persist events)
- ✅ Replay capability
- ✅ Multi-subscriber

**Event flow:**
```
Vendure Core                Inventory Service
     │                            │
     │─────OrderCreated──────────>│
     │                            │ Create reservation
     │                            │
     │<────StockReserved──────────│
     │                            │
     │ Process payment            │
     │                            │
     │────PaymentSuccess─────────>│
     │                            │ Confirm reservation
     │                            │
     │<────StockAllocated─────────│
```

**Topics:**
```
eazyshop.orders.created
eazyshop.orders.paid
eazyshop.orders.cancelled
eazyshop.inventory.reserved
eazyshop.inventory.allocated
eazyshop.inventory.released
```

**Consumer groups:**
```typescript
@Consumer('eazyshop.orders.paid')
class InventoryConsumer {
  @Subscribe()
  async handleOrderPaid(message: OrderPaidEvent) {
    await this.inventoryService.confirmReservation(message.orderId);
  }
}

@Consumer('eazyshop.orders.paid')
class ShippingConsumer {
  @Subscribe()
  async handleOrderPaid(message: OrderPaidEvent) {
    await this.shippingService.createShipment(message.orderId);
  }
}
```

---

### 4.4. Deployment Strategy

**Kubernetes setup:**

```yaml
# inventory-service deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
spec:
  replicas: 10  # Horizontal scaling
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 2
      maxUnavailable: 1
  template:
    spec:
      containers:
      - name: inventory-service
        image: eazyshop/inventory:v1.2.3
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "1000m"
            memory: "1Gi"
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: inventory-db-credentials
              key: url
        - name: REDIS_URL
          value: "redis://redis-cluster:6379"
---
# HPA: Auto-scale based on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: inventory-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: inventory-service
  minReplicas: 10
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

---

### 4.5. Monitoring & Observability

**Stack:**
- **Metrics:** Prometheus + Grafana
- **Logs:** ELK Stack (Elasticsearch + Logstash + Kibana)
- **Tracing:** Jaeger (distributed tracing)
- **Alerts:** PagerDuty

**Key metrics to track:**

```typescript
// Inventory service metrics
metrics.histogram('inventory.reservation.duration');
metrics.counter('inventory.reservation.created');
metrics.counter('inventory.reservation.failed');
metrics.gauge('inventory.stock.available', { variantId });

// Dashboards
[Inventory Dashboard]
- Reservation rate (per second)
- P50/P95/P99 latency
- Error rate
- Stock availability by variant
- Lock contention (wait time)

[Order Dashboard]
- Order processing time
- Payment success rate
- Fulfillment time
- Webhook delivery rate

[Infrastructure Dashboard]
- Database connections
- Redis hit rate
- Kafka lag
- Pod CPU/Memory
```

---

## 5. Tổng kết

### 5.1. Key Takeaways

1. **Inventory Reservation** cần:
   - ✅ Pessimistic locking cho consistency
   - ✅ Background cleanup cho expired reservations
   - ✅ Event-driven architecture cho scalability

2. **Scale Vendure** cần:
   - ✅ Database sharding theo channel/warehouse
   - ✅ Microservices cho inventory + order processing
   - ✅ Event bus (Kafka) cho decoupling
   - ✅ Multi-layer caching

3. **Trade-offs:**
   - Consistency vs Performance → Strong consistency cho stock, eventual cho catalog
   - Monolith vs Microservices → Bắt đầu monolith, tách khi cần
   - Sync vs Async → Sync cho critical path, async cho notifications

### 5.2. Implementation Roadmap

**Phase 1 (Month 1-2): Foundation**
- ✅ Implement inventory reservation trong Vendure monolith
- ✅ Add read replicas
- ✅ Setup Redis caching

**Phase 2 (Month 3-4): Extract Inventory Service**
- ✅ Tách inventory thành microservice
- ✅ Event bus với Kafka
- ✅ Database sharding

**Phase 3 (Month 5-6): Extract Order Processing**
- ✅ Tách order processing service
- ✅ Queue-based webhook delivery
- ✅ Saga pattern cho distributed transactions

**Phase 4 (Month 7+): Optimize & Monitor**
- ✅ Auto-scaling với K8s HPA
- ✅ Advanced caching strategies
- ✅ Machine learning cho demand forecasting

---

**END OF DESIGN DOCUMENT**

# EAZYLAB – Middle Backend Mini Test

## Core B – Inventory Reservation

**Ứng viên:** Lê Huy Phước

---

# 1. Mục tiêu & Tư duy thiết kế

Tính năng “Giữ hàng tạm thời” (Inventory Reservation) nhằm đảm bảo rằng khi nhiều khách hàng cùng lúc tương tác với cùng một sản phẩm, hệ thống **không bị oversell** so với khả năng bán thực tế. Mục tiêu ta hướng tới không phải sẽ implement lại module tồn kho mà sẽ **mở rộng cái mà Vendure đang vận hành**, bằng cách thêm một lớp reservation nằm trước giai đoạn stock allocation.

Hướng thiết kế:

* Không sửa core của Vendure.
* Không tác động trực tiếp `stockOnHand` hoặc `stockAllocated` khi khách mới chỉ thêm vào giỏ.
* Sử dụng plugin + entity riêng + lifecycle hooks.

---

# 2. Mô hình tồn kho hiện tại của Vendure

Vendure hiện có 3 khái niệm quan trọng:

### **• stockOnHand**

Lượng tồn kho thật trong kho. Chỉ thay đổi khi fulfillment, import, manual chỉnh sửa.

### **• stockAllocated**

Số hàng đã “được giữ chính thức” cho các đơn hàng trong luồng checkout.

### **• saleable = stockOnHand - stockAllocated**

Số lượng còn lại hệ thống *có thể bán*.

**Nhược điểm:** Vendure không giữ hàng khi item mới được thêm vào giỏ, dẫn đến race condition nếu nhiều người add to cart cùng lúc.

**Giải pháp:** Thêm một lớp `StockReservation` ở trước `stockAllocated`.

---

# 3. Thiết kế dữ liệu

Thay vì chỉnh sửa ProductVariant hoặc OrderLine, ta tạo một bảng riêng để lưu trữ các reservation.

```text
StockReservation
------------------------------
- id: ID
- orderId: liên kết tới Order hiện tại
- orderLineId: optional nhưng hữu ích khi order line bị xóa/sửa
- productVariantId
- quantity
- status: PENDING | CONFIRMED | RELEASED
- expiresAt: thời điểm reservation hết hạn
- createdAt / updatedAt
```

## Lý do cần entity riêng

* Dễ query tổng số lượng đang giữ theo variant.
* Có thể index theo `productVariantId`, `status`, `expiresAt` giúp performance tốt hơn.
* Không làm "phình" bảng của Vendure (orderLine / variant).
* Tách biệt vòng đời reservation khỏi vòng đời orderLine.
* Phù hợp định hướng scale trong tương lai.

---

# 4. Luồng xử lý chi tiết

# 4.1 Khi khách thêm sản phẩm vào giỏ hàng

Hook: `OrderLineEvent` hoặc override logic `addItemToOrder`.

### Bước xử lý:

1. Lấy variant + số lượng khách muốn thêm.
2. Tính:

   ```text
   reservedPending = tổng reservation PENDING cho variant đó
   saleable = stockOnHand - stockAllocated - reservedPending
   ```
3. Nếu saleable < quantity → từ chối, trả về lỗi.
4. Nếu hợp lệ → tạo reservation:

   ```text
   status = PENDING
   expiresAt = now + CART_TTL (ví dụ 20–30 phút)
   ```
5. Trả về orderLine bình thường.

### Vì sao logic này an toàn?

Reservation được lưu vào DB ngay trong transaction → các request khác sẽ nhìn thấy con số mới ngay lập tức.

---

# 4.2 Khi khách chỉnh sửa số lượng trong giỏ hàng

Case: tăng số lượng

* Kiểm tra saleable như bước trên.
* Nếu hợp lệ → tăng reservation.

Case: giảm số lượng

* Giảm reservation tương ứng.

Case: xóa sản phẩm khỏi giỏ hàng

* Tìm reservation tương ứng orderId + variant.
* Chuyển trạng thái sang `RELEASED`.

---

# 4.3 Khi khách thanh toán thành công

Hook: `OrderProcess.onTransitionEnd` (khi vào PaymentSettled hoặc PaymentAuthorized).

### Xử lý:

1. Tất cả reservation thuộc order → đổi từ `PENDING` → `CONFIRMED`.
2. Lúc này, Vendure tự điều khiển stock allocation → **stockAllocated tăng**.

---

# 4.4 Khi đơn hủy hoặc giỏ hết hạn

Có hai trường hợp:

## A. User chủ động hủy đơn

Hook: order state → `Cancelled`.

* Các reservation chuyển sang `RELEASED`.
* Không thay đổi stockOnHand/Allocated.

## B. Giỏ hết hạn

* Job Scheduler sẽ chạy mỗi X phút.
* Scan reservation có `expiresAt < now` và `status = PENDING`.
* Chuyển sang `RELEASED`.

---

# 5. Concurrency & Multi-node

## 5.1 Race conditions & solution

* Khi tạo hoặc tăng reservation: dùng **DB transaction**.
* Dùng query dạng:

  ```sql
  UPDATE stock_level
  SET reserved = reserved + X
  WHERE product_variant_id = ? AND saleable >= X
  ```
* Kiểm tra rowsAffected = 1.

Nếu rowsAffected = 0 → người khác đã giữ trước → không còn hàng.

## 5.2 Multi-node

Nếu chạy nhiều server:

* Dùng distributed lock (Redis → RedLock) khi cần.
* Tuy nhiên phần quan trọng nhất vẫn là atomic update ở DB.

## 5.3 Một user mở nhiều tab

* Reservation gắn với orderId.
* Các tab của user đều share chung giỏ hàng.
* Không thể tăng hoặc giảm trùng.

---

# 6. Ví dụ minh họa chi tiết

Variant A tồn kho ban đầu:

```
stockOnHand = 10
stockAllocated = 0
reservedPending = 0
saleable = 10
```

## Giỏ A thêm 2

```
reservedPending = 2
saleable = 8
```

## Giỏ B thêm 3

```
reservedPending = 5
saleable = 5
```

## Giỏ C thêm 6 → bị từ chối

Saleable = 5. Không đủ cho 6.

## Giỏ A thanh toán thành công

* Reservation A → CONFIRMED
* Vendure allocate stockAllocated += 2

## Giỏ B bị hủy

* Reservation B → RELEASED

Final:

```
stockOnHand = 10
stockAllocated = 2
reservedPending = 0
saleable = 8
```

---

# 7. Domain Thinking – build thành plugin Vendure

## Hook cần dùng

* `OrderLineEvent`: add/update/remove item
* `OrderStateTransitionEvent`: payment settled, cancelled
* `JobQueue`: cleanup reservation
* `EventBus`: publish event khi reservation tạo/giải phóng

## Lưu dữ liệu ở đâu?

* Entity mới `StockReservation`
* Không ghi customFields vì cần index truy vấn variant
* Không mở rộng productVariant vì tách biệt business logic

## Tính tương thích

* Không sửa core, không override service gốc
* Không thay đổi logic allocate/fulfill của Vendure
* Đảm bảo plugin không làm sai flow promotion hoặc shipping

---

# 8. Vấn đề khi scale Vendure

## 8.1 Những vấn đề thường gặp

* Query product/variant nặng khi multi-channel
* DB contention ở bảng `stock_level` khi lưu lượng lớn
* EventBus mặc định in-memory không scale multi-node
* Job queue built-in dễ quá tải với shop lớn
* Tồn kho không đồng bộ giữa nhiều node

## 8.2 Hạn chế của Vendure

* TypeORM gây ra n+1 queries nếu không tối ưu
* Multi-tenant chia sẻ DB dễ tạo contention
* Search index đồng bộ chậm khi catalog lớn
* Fulfillment flow không tách service

## 8.3 Chiến lược scale EazyShop

### Khi nào tách microservices?

* Khi lượng order/s giây vượt khả năng node Vendure
* Khi inventory gây lock contention
* Khi muốn cho phép tồn kho real-time theo warehouse

### Module tách trước:

1. **Inventory Service**
2. **Search Service** (Elastic)
3. **Checkout/Order Orchestrator**
4. **Analytics**

### Giảm tải database

* Dùng read replicas cho query catalog
* Cache product/variant theo channel (Redis ~ 30s)
* Sử dụng materialized view tổng hợp stock

### Consistency vs Performance

* Stock → strong consistency (transaction)
* Catalog → eventual (cache + CDN)
* Notification/order updates → async (queue)

### Multi-channel tránh query nặng

* Preload relations
* Cache theo channel
* Phân tách bảng theo tenant

---

# 9. Kiến trúc tương lai phù hợp

```
           API Gateway
                |
      -----------------------
      |         |           |
  Vendure     Inventory    Order
   Core        Service    Orchestrator
 (Catalog,    (Stock &    (Payment,
  Cart)      Reservation)  Fulfill)
       \         |         /
            Event Bus
        (Kafka / NATS)
                |
       Search —— Analytics —— Webhooks
```

---

# 10. Sequence Diagrams

## 10.1 Add to Cart Flow (Reservation Creation)

```
Customer                OrderInterceptor         ReservationService         Database
   │                           │                         │                      │
   │  Add item (qty: 5)        │                         │                      │
   ├──────────────────────────►│                         │                      │
   │                           │                         │                      │
   │                           │  createOrUpdate()       │                      │
   │                           ├────────────────────────►│                      │
   │                           │                         │                      │
   │                           │                         │  BEGIN TRANSACTION   │
   │                           │                         ├─────────────────────►│
   │                           │                         │                      │
   │                           │                         │  SELECT ... FOR UPDATE
   │                           │                         │  (Lock variant row)  │
   │                           │                         │◄─────────────────────┤
   │                           │                         │                      │
   │                           │                         │  Calculate available │
   │                           │                         │  = stockOnHand       │
   │                           │                         │    - allocated       │
   │                           │                         │    - reserved        │
   │                           │                         │                      │
   │                           │                         │  Check sufficient?   │
   │                           │                         │    Yes               │
   │                           │                         │                      │
   │                           │                         │  INSERT/UPDATE       │
   │                           │                         │  stock_reservation   │
   │                           │                         ├─────────────────────►│
   │                           │                         │                      │
   │                           │                         │  COMMIT              │
   │                           │                         ├─────────────────────►│
   │                           │                         │                      │
   │                           │    Success              │                      │
   │                           │◄────────────────────────┤                      │
   │                           │                         │                      │
   │    Item added             │                         │                      │
   │◄──────────────────────────┤                         │                      │
   │                           │                         │                      │
```

---

## 10.2 Race Condition Handling (Two users add same product)

```
Customer A              Customer B              Database (PostgreSQL)
   │                       │                            │
   │  Reserve 3            │  Reserve 3                 │
   ├──────────────────────►│                            │
   │                       ├───────────────────────────►│
   │                       │                            │
   │                       │      BEGIN TX_A            │
   │                       │      SELECT FOR UPDATE     │
   │                       │      (Lock acquired)       │
   │                       │                            │
   │                       │      BEGIN TX_B            │
   │                       │      SELECT FOR UPDATE     │
   │                       │      (Waiting for lock...) │
   │                       │                            │
   │                       │      TX_A: Check stock = 5 │
   │                       │      TX_A: Reserve 3       │
   │                       │      TX_A: COMMIT          │
   │                       │      (Lock released)       │
   │                       │                            │
   │                       │      TX_B: Lock acquired   │
   │                       │      TX_B: Check stock = 2 │
   │                       │      TX_B: Insufficient!   │
   │                       │      TX_B: ROLLBACK        │
   │                       │◄───────────────────────────┤
   │  ✓ Reserved           │  ✗ Failed                  │
   │◄──────────────────────┤  (Only 2 available)        │
   │                       │                            │
```

---

## 10.3 Payment Flow

```
Order              OrderProcess           ReservationService         Database
  │                    │                         │                      │
  │  PaymentSettled    │                         │                      │
  ├───────────────────►│                         │                      │
  │                    │                         │                      │
  │                    │  confirmReservations()  │                      │
  │                    ├────────────────────────►│                      │
  │                    │                         │                      │
  │                    │                         │  UPDATE status       │
  │                    │                         │  SET CONFIRMED       │
  │                    │                         ├─────────────────────►│
  │                    │                         │                      │
  │                    │                         │   Updated            │
  │                    │                         │◄─────────────────────┤
  │                    │                         │                      │
  │                    │    Done                 │                      │
  │                    │◄────────────────────────┤                      │
  │                    │                         │                      │
  │  (Vendure creates  │                         │                      │
  │   Allocation)      │                         │                      │
  │◄───────────────────┤                         │                      │
  │                    │                         │                      │
```

---

## 10.4 Cleanup Job Flow

```
Scheduler        CleanupService      ReservationService       Database
   │                   │                     │                    │
   │  Every 1 min      │                     │                    │
   ├──────────────────►│                     │                    │
   │                   │                     │                    │
   │                   │  cleanupExpired()   │                    │
   │                   ├────────────────────►│                    │
   │                   │                     │                    │
   │                   │                     │  SELECT *          │
   │                   │                     │  WHERE status=     │
   │                   │                     │    'RESERVED'      │
   │                   │                     │  AND expiresAt <   │
   │                   │                     │    NOW()           │
   │                   │                     ├───────────────────►│
   │                   │                     │                    │
   │                   │                     │  Found 5 expired   │
   │                   │                     │◄───────────────────┤
   │                   │                     │                    │
   │                   │                     │  UPDATE status =   │
   │                   │                     │    'RELEASED'      │
   │                   │                     ├───────────────────►│
   │                   │                     │                    │
   │                   │  Cleaned: 5         │                    │
   │                   │◄────────────────────┤                    │
   │                   │                     │                    │
   │  Log: 5 cleaned   │                     │                    │
   │◄──────────────────┤                     │                    │
   │                   │                     │                    │
```

---

## 10.5. State Transition Diagram

```
                 ┌──────────────┐
                 │  AddingItems │
                 └──────┬───────┘
                        │
                        │ Customer adds item
                        ▼
                ┌───────────────┐
                │  RESERVATION  │
                │    CREATED    │
                │status:RESERVED│
                └───────┬───────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        │ Timeout       │ Payment       │ Cancel
        │ (15 min)      │ Success       │ Order
        │               │               │
        ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ RESERVATION  │ │ RESERVATION  │ │ RESERVATION  │
│  RELEASED    │ │  CONFIRMED   │ │  RELEASED    │
│              │ │              │ │              │
│ Stock freed  │ │ → Allocation │ │ Stock freed  │
└──────────────┘ └──────────────┘ └──────────────┘
```
# Tài liệu tham khảo

### **Vendure Core Concepts**

* Stock Control: [https://docs.vendure.io/guides/core-concepts/stock-control/](https://docs.vendure.io/guides/core-concepts/stock-control/)
* Order Process & State Machine: [https://docs.vendure.io/guides/core-concepts/orders/#order-process](https://docs.vendure.io/guides/core-concepts/orders/#order-process)
* Plugin Architecture: [https://docs.vendure.io/guides/plugins/writing-plugins/](https://docs.vendure.io/guides/plugins/writing-plugins/)
* Event Bus: [https://docs.vendure.io/reference/typescript-api/event-bus/](https://docs.vendure.io/reference/typescript-api/event-bus/)
* StockLevel API: [https://docs.vendure.io/reference/typescript-api/entities/stock-level/](https://docs.vendure.io/reference/typescript-api/entities/stock-level/)
* ProductVariant API: [https://docs.vendure.io/reference/typescript-api/entities/product-variant/](https://docs.vendure.io/reference/typescript-api/entities/product-variant/)
* JobQueue: [https://docs.vendure.io/reference/typescript-api/job-queue/](https://docs.vendure.io/reference/typescript-api/job-queue/)
* Checkout Flow (Storefront): [https://docs.vendure.io/guides/storefront/checkout-flow/](https://docs.vendure.io/guides/storefront/checkout-flow/)

### **Blog & External Resources**

* Vendure v0.17 – cải tiến Stock Management: [https://vendure.io/blog/2020/11/announcing-vendure-v0-17-0/](https://vendure.io/blog/2020/11/announcing-vendure-v0-17-0/)
* Stock Monitoring Plugin (Pinelab): [https://vendure.io/plugins/stock-monitoring/](https://vendure.io/plugins/stock-monitoring/)


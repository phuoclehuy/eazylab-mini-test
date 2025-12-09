import { DeepPartial, ID, Order, ProductVariant, StockLocation, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';
import { ReservationStatus } from '../types';

/**
 * Entity lưu trữ thông tin về việc giữ hàng tạm thời
 * 
 * Mỗi khi khách hàng thêm sản phẩm vào giỏ, một StockReservation được tạo
 * để đảm bảo số lượng đó sẽ không bị bán cho người khác
 */
@Entity()
export class StockReservation extends VendureEntity {
    constructor(input?: DeepPartial<StockReservation>) {
        super(input);
    }

    /**
     * Product variant đang được giữ
     */
    @Index()
    @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
    productVariant!: ProductVariant;

    @Column()
    productVariantId!: ID;

    /**
     * Order mà reservation này thuộc về
     */
    @Index()
    @ManyToOne(() => Order, { onDelete: 'CASCADE' })
    order!: Order;

    @Column()
    orderId!: ID;

    /**
     * Stock location nơi hàng được giữ
     */
    @ManyToOne(() => StockLocation, { onDelete: 'CASCADE' })
    stockLocation!: StockLocation;

    @Column()
    stockLocationId!: ID;

    /**
     * Số lượng đang được giữ
     */
    @Column()
    quantity!: number;

    /**
     * Trạng thái của reservation
     */
    @Index()
    @Column({ type: 'varchar' })
    status!: ReservationStatus;

    /**
     * Thời điểm reservation này hết hạn
     * Sau thời điểm này, hàng sẽ được tự động giải phóng
     */
    @Index()
    @Column()
    expiresAt!: Date;

    /**
     * Channel ID
     */
    @Index()
    @Column({ nullable: true })
    channelId?: ID;
}

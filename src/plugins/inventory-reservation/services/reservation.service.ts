import {
    RequestContext,
    TransactionalConnection,
    ID,
    ProductVariant,
    StockLevel,
    Logger,
} from '@vendure/core';
import { Injectable } from '@nestjs/common';
import { StockReservation } from '../entities/stock-reservation.entity';
import { InsufficientStockForReservationError, ReservationStatus } from '../types';

const loggerCtx = 'ReservationService';

@Injectable()
export class ReservationService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Tạo hoặc cập nhật reservation cho một order line
     * 
     * Sử dụng pessimistic locking để tránh race condition
     */
    async createOrUpdateReservation(
        ctx: RequestContext,
        input: {
            orderId: ID;
            productVariantId: ID;
            stockLocationId: ID;
            quantity: number;
            ttlMs: number;
        },
    ): Promise<StockReservation> {
        return await this.connection.withTransaction(ctx, async (em) => {
            // Lock row để tránh race condition
            const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
                where: { id: input.productVariantId as any },
                lock: { mode: 'pessimistic_write' },
            });

            if (!variant) {
                throw new Error(`ProductVariant ${input.productVariantId} not found`);
            }

            // Tính available stock
            const availableStock = await this.getAvailableStock(
                ctx,
                em,
                String(input.productVariantId),
                input.stockLocationId,
                input.orderId,
            );

            if (availableStock < input.quantity) {
                throw new InsufficientStockForReservationError(
                    String(input.productVariantId),
                    input.quantity,
                    availableStock,
                );
            }

            // Kiểm tra xem đã có reservation cho order line này chưa
            let reservation = await this.connection.getRepository(ctx, StockReservation).findOne({
                where: {
                    orderId: input.orderId as any,
                    productVariantId: input.productVariantId as any,
                    status: ReservationStatus.RESERVED,
                },
            });

            const expiresAt = new Date(Date.now() + input.ttlMs);

            if (reservation) {
                // Update reservation hiện có
                reservation.quantity = input.quantity;
                reservation.expiresAt = expiresAt;
                Logger.debug(
                    `Updated reservation ${reservation.id} for order ${input.orderId}`,
                    loggerCtx,
                );
            } else {
                // Tạo mới reservation
                reservation = new StockReservation({
                    orderId: input.orderId,
                    productVariantId: input.productVariantId,
                    stockLocationId: input.stockLocationId,
                    quantity: input.quantity,
                    status: ReservationStatus.RESERVED,
                    expiresAt,
                    channelId: ctx.channelId,
                });
                Logger.debug(
                    `Created new reservation for order ${input.orderId}, variant ${input.productVariantId}`,
                    loggerCtx,
                );
            }

            await this.connection.getRepository(ctx, StockReservation).save(reservation);
            return reservation;
        });
    }

    /**
     * Tính available stock = stockOnHand - allocated - reserved (của orders khác)
     * 
     * Không tính reserved của order hiện tại (để có thể update quantity)
     */
    async getAvailableStock(
        ctx: RequestContext,
        em: any,
        productVariantId: string | ID,
        stockLocationId: ID,
        excludeOrderId?: ID,
    ): Promise<number> {
        // Lấy stock level từ Vendure
        const stockLevel = await this.connection.getRepository(ctx, StockLevel).findOne({
            where: {
                productVariantId: productVariantId as any,
                stockLocationId: stockLocationId as any,
            },
        });

        if (!stockLevel) {
            return 0;
        }

        // Tính tổng số hàng đang được reserve (trừ order hiện tại)
        const reservedQtyResult = await em
            .createQueryBuilder(StockReservation, 'reservation')
            .select('SUM(reservation.quantity)', 'total')
            .where('reservation.productVariantId = :variantId', { variantId: productVariantId })
            .andWhere('reservation.stockLocationId = :locationId', { locationId: stockLocationId })
            .andWhere('reservation.status = :status', { status: ReservationStatus.RESERVED })
            .andWhere('reservation.expiresAt > :now', { now: new Date() })
            .andWhere(
                excludeOrderId
                    ? 'reservation.orderId != :orderId'
                    : '1=1',
                { orderId: excludeOrderId },
            )
            .getRawOne();

        const reservedQty = parseInt(reservedQtyResult?.total || '0', 10);

        // Available = stockOnHand - allocated - reserved
        const available = stockLevel.stockOnHand - stockLevel.stockAllocated - reservedQty;

        Logger.debug(
            `Available stock for variant ${productVariantId}: ${available} ` +
            `(stockOnHand: ${stockLevel.stockOnHand}, allocated: ${stockLevel.stockAllocated}, reserved: ${reservedQty})`,
            loggerCtx,
        );

        return Math.max(0, available);
    }

    /**
     * Confirm tất cả reservations của một order (khi thanh toán thành công)
     */
    async confirmReservations(ctx: RequestContext, orderId: ID): Promise<void> {
        await this.connection.withTransaction(ctx, async (em) => {
            const reservations = await this.connection.getRepository(ctx, StockReservation).find({
                where: {
                    orderId: orderId as any,
                    status: ReservationStatus.RESERVED,
                },
            });

            for (const reservation of reservations) {
                reservation.status = ReservationStatus.CONFIRMED;
                await this.connection.getRepository(ctx, StockReservation).save(reservation);
                Logger.debug(
                    `Confirmed reservation ${reservation.id} for order ${orderId}`,
                    loggerCtx,
                );
            }
        });
    }

    /**
     * Release tất cả reservations của một order (khi cancel hoặc timeout)
     */
    async releaseReservations(ctx: RequestContext, orderId: ID): Promise<void> {
        await this.connection.withTransaction(ctx, async (em) => {
            const reservations = await this.connection.getRepository(ctx, StockReservation).find({
                where: {
                    orderId: orderId as any,
                    status: ReservationStatus.RESERVED,
                },
            });

            for (const reservation of reservations) {
                reservation.status = ReservationStatus.RELEASED;
                await this.connection.getRepository(ctx, StockReservation).save(reservation);
                Logger.debug(
                    `Released reservation ${reservation.id} for order ${orderId}`,
                    loggerCtx,
                );
            }
        });
    }

    /**
     * Cleanup expired reservations (cron job)
     */
    async cleanupExpiredReservations(ctx: RequestContext): Promise<number> {
        return await this.connection.withTransaction(ctx, async (em) => {
            const expiredReservations = await this.connection
                .getRepository(ctx, StockReservation)
                .createQueryBuilder('reservation')
                .where('reservation.status = :status', { status: ReservationStatus.RESERVED })
                .andWhere('reservation.expiresAt < :now', { now: new Date() })
                .getMany();

            for (const reservation of expiredReservations) {
                reservation.status = ReservationStatus.RELEASED;
                await this.connection.getRepository(ctx, StockReservation).save(reservation);
            }

            if (expiredReservations.length > 0) {
                Logger.info(
                    `Cleaned up ${expiredReservations.length} expired reservations`,
                    loggerCtx,
                );
            }

            return expiredReservations.length;
        });
    }

    /**
     * Extend expiration time của reservation (khi customer update giỏ hàng)
     */
    async extendReservation(
        ctx: RequestContext,
        orderId: ID,
        productVariantId: ID,
        ttlMs: number,
    ): Promise<void> {
        await this.connection.withTransaction(ctx, async (em) => {
            const reservation = await this.connection.getRepository(ctx, StockReservation).findOne({
                where: {
                    orderId: orderId as any,
                    productVariantId: productVariantId as any,
                    status: ReservationStatus.RESERVED,
                },
            });

            if (reservation) {
                reservation.expiresAt = new Date(Date.now() + ttlMs);
                await this.connection.getRepository(ctx, StockReservation).save(reservation);
                Logger.debug(
                    `Extended reservation ${reservation.id} for order ${orderId}`,
                    loggerCtx,
                );
            }
        });
    }

    /**
     * Lấy tất cả reservations của một order
     */
    async getOrderReservations(ctx: RequestContext, orderId: ID): Promise<StockReservation[]> {
        return await this.connection.getRepository(ctx, StockReservation).find({
            where: { orderId },
            relations: ['productVariant', 'stockLocation'],
        });
    }
}

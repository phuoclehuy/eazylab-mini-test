import { OrderProcess, OrderState, Injector, Logger } from '@vendure/core';
import { ReservationService } from '../services/reservation.service';

const loggerCtx = 'ReservationOrderProcess';

let reservationService: ReservationService;

/**
 * Custom OrderProcess để xử lý reservation lifecycle
 * 
 * Hook vào các transition points của Order để:
 * - Confirm reservation khi thanh toán thành công
 * - Release reservation khi order bị cancel
 */
export const reservationOrderProcess: OrderProcess<OrderState> = {
    init(injector: Injector) {
        reservationService = injector.get(ReservationService);
    },

    async onTransitionEnd(fromState, toState, data) {
        const { order, ctx } = data;

        // Confirm reservation khi thanh toán thành công
        if (toState === 'PaymentSettled' || toState === 'PaymentAuthorized') {
            Logger.info(
                `Order ${order.code} payment settled, confirming reservations`,
                loggerCtx,
            );
            await reservationService.confirmReservations(ctx, order.id);
        }

        // Release reservation khi order bị cancel
        if (toState === 'Cancelled') {
            Logger.info(
                `Order ${order.code} cancelled, releasing reservations`,
                loggerCtx,
            );
            await reservationService.releaseReservations(ctx, order.id);
        }

        // Release reservation khi order transition về AddingItems (customer quay lại giỏ hàng)
        if (fromState === 'ArrangingPayment' && toState === 'AddingItems') {
            Logger.info(
                `Order ${order.code} returned to cart, extending reservations`,
                loggerCtx,
            );
            // Có thể extend thời gian reservation ở đây nếu cần
        }
    },

    async onTransitionStart(fromState, toState, data) {
        const { order, ctx } = data;

        // Kiểm tra reservation khi transition sang ArrangingPayment
        if (fromState === 'AddingItems' && toState === 'ArrangingPayment') {
            const reservations = await reservationService.getOrderReservations(ctx, order.id);
            
            // Kiểm tra xem có reservation nào expired không
            const now = new Date();
            const hasExpired = reservations.some(r => r.expiresAt < now);
            
            if (hasExpired) {
                Logger.warn(
                    `Order ${order.code} has expired reservations, cannot proceed to payment`,
                    loggerCtx,
                );
                return 'Some items in your cart are no longer available. Please review your cart.';
            }
        }
    },
};

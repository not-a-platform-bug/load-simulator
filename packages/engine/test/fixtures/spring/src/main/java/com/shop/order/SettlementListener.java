package com.shop.order;

import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.stereotype.Component;

@Component
public class SettlementListener {
    private final LedgerRepository ledgerRepository;

    public SettlementListener(LedgerRepository ledgerRepository) {
        this.ledgerRepository = ledgerRepository;
    }

    @RabbitListener(queues = "order-events")
    public void onOrder(OrderEvent e) {
        ledgerRepository.save(Ledger.of(e));
    }
}

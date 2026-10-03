package com.shop.order;

import org.springframework.stereotype.Service;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.scheduling.annotation.Scheduled;

@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final PaymentClient paymentClient;
    private final RabbitTemplate rabbitTemplate;

    public OrderService(OrderRepository orderRepository, PaymentClient paymentClient, RabbitTemplate rabbitTemplate) {
        this.orderRepository = orderRepository;
        this.paymentClient = paymentClient;
        this.rabbitTemplate = rabbitTemplate;
    }

    public OrderDto place(CreateOrder req) {
        for (Item item : req.items()) {
            orderRepository.findStock(item.sku());
        }
        Order saved = orderRepository.save(Order.from(req));
        paymentClient.approve(new PaymentRequest(saved.getId()));
        rabbitTemplate.convertAndSend("order-events", saved);
        return OrderDto.of(saved);
    }

    public OrderDto find(Long id) {
        return OrderDto.of(orderRepository.findById(id).orElseThrow());
    }

    @Scheduled(fixedRate = 30000)
    public void expireCarts() {
        orderRepository.deleteExpired();
    }
}

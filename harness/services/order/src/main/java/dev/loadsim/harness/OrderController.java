package dev.loadsim.harness;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
    private final JdbcTemplate jdbc;
    private final StringRedisTemplate redis;
    private final PaymentClient payment;
    private final StockClient stock;
    private final RabbitTemplate rabbitTemplate;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final double productCpuMs;
    private final double orderCpuMs;
    private final String messaging;
    private final Duration cacheTtl;

    public OrderController(
            JdbcTemplate jdbc,
            StringRedisTemplate redis,
            PaymentClient payment,
            StockClient stock,
            RabbitTemplate rabbitTemplate,
            KafkaTemplate<String, String> kafkaTemplate,
            @Value("${app.cpu.products-ms:1}") double productCpuMs,
            @Value("${app.cpu.orders-ms:3}") double orderCpuMs,
            @Value("${app.messaging:rabbit}") String messaging,
            @Value("${app.cache-ttl:30s}") Duration cacheTtl) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.payment = payment;
        this.stock = stock;
        this.rabbitTemplate = rabbitTemplate;
        this.kafkaTemplate = kafkaTemplate;
        this.productCpuMs = productCpuMs;
        this.orderCpuMs = orderCpuMs;
        this.messaging = messaging;
        this.cacheTtl = cacheTtl;
    }

    @GetMapping("/products/{id}")
    public Map<String, Object> product(@PathVariable long id) {
        CpuWork.burn(productCpuMs);
        String key = "product:" + id;
        String cached = redis.opsForValue().get(key);
        if (cached != null) return Map.of("id", id, "name", cached, "cache", true);
        String name = jdbc.queryForObject("SELECT name FROM products WHERE id = ?", String.class, 1 + id % 1000);
        redis.opsForValue().set(key, name, cacheTtl);
        return Map.of("id", id, "name", name, "cache", false);
    }

    @PostMapping("/orders")
    public Map<String, Object> order() {
        CpuWork.burn(orderCpuMs);
        int items = 1 + ThreadLocalRandom.current().nextInt(3);
        for (int i = 0; i < items; i++) stock.check(1 + ThreadLocalRandom.current().nextInt(1000));
        long amount = 1000 + ThreadLocalRandom.current().nextInt(9000);
        jdbc.update("INSERT INTO orders (amount, items) VALUES (?, ?)", amount, items);
        String status = payment.approve(amount);
        String event = "{\"amount\":" + amount + ",\"status\":\"" + status + "\"}";
        if (!"kafka".equals(messaging)) rabbitTemplate.convertAndSend("order-events", event);
        if (!"rabbit".equals(messaging)) kafkaTemplate.send("order-events", String.valueOf(amount % 64), event);
        return Map.of("items", items, "payment", status);
    }
}

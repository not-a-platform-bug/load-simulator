package dev.loadsim.harness;

import java.util.Map;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class PaymentApplication {
    public static void main(String[] args) {
        SpringApplication.run(PaymentApplication.class, args);
    }
}

@RestController
class PaymentController {
    private final JdbcTemplate jdbc;

    PaymentController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @PostMapping("/payments/approve")
    public Map<String, Object> approve(@RequestBody Map<String, Object> req) {
        long amount = ((Number) req.getOrDefault("amount", 0)).longValue();
        jdbc.update("INSERT INTO payments (amount, status) VALUES (?, 'APPROVED')", amount);
        return Map.of("status", "APPROVED");
    }
}

/** Settlement: the same handler consumed from RabbitMQ or Kafka (app.messaging decides which listener runs). */
@Component
class SettlementListener {
    private final JdbcTemplate jdbc;
    private final double cpuMs;

    SettlementListener(JdbcTemplate jdbc, @Value("${app.cpu.settle-ms:1}") double cpuMs) {
        this.jdbc = jdbc;
        this.cpuMs = cpuMs;
    }

    private void settle(String event) {
        long end = System.nanoTime() + (long) (cpuMs * 1_000_000);
        while (System.nanoTime() < end) Thread.onSpinWait();
        jdbc.update("INSERT INTO ledger (event) VALUES (?)", event);
    }

    @RabbitListener(queues = "order-events", autoStartup = "${app.rabbit.enabled:true}")
    public void onRabbit(String event) {
        settle(event);
    }

    @KafkaListener(topics = "order-events", groupId = "settlement", autoStartup = "${app.kafka.enabled:false}")
    public void onKafka(String event) {
        settle(event);
    }
}

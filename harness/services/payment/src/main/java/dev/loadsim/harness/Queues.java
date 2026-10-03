package dev.loadsim.harness;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.amqp.core.Queue;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class Queues {
    @Bean
    Queue orderEvents() {
        return new Queue("order-events", true);
    }

    @Bean
    NewTopic orderEventsTopic(@Value("${app.kafka.partitions:6}") int partitions) {
        return new NewTopic("order-events", partitions, (short) 1);
    }
}

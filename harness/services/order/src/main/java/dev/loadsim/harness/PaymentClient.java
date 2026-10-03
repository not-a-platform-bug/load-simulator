package dev.loadsim.harness;

import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** order → payment. Timeouts come from the HTTP client; breaker and retry from resilience4j.*.instances.payment. */
@Component
public class PaymentClient {
    private final RestClient client;

    public PaymentClient(HttpClients clients) {
        this.client = clients.payment();
    }

    @CircuitBreaker(name = "payment", fallbackMethod = "pending")
    @Retry(name = "payment")
    public String approve(long amount) {
        Map<?, ?> res = client.post().uri("/payments/approve").body(Map.of("amount", amount)).retrieve().body(Map.class);
        return res == null ? "UNKNOWN" : String.valueOf(res.get("status"));
    }

    /** fallback: accept the order and settle the payment later */
    String pending(long amount, Throwable t) {
        return "PENDING";
    }
}

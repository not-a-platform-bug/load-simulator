package dev.loadsim.harness;

import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class StockClient {
    private final RestClient client;

    public StockClient(HttpClients clients) {
        this.client = clients.stock();
    }

    public int check(long sku) {
        Map<?, ?> res = client.get().uri("/stocks/{id}", sku).retrieve().body(Map.class);
        return res == null ? 0 : ((Number) res.get("quantity")).intValue();
    }
}

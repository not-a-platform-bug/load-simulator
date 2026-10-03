package dev.loadsim.harness;

import java.net.http.HttpClient;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/**
 * HTTP clients with keep-alive connection reuse and per-target timeouts, matching the simulator's
 * edge settings (edges.order->payment.timeout / connectTimeout). The URLs point at Toxiproxy so faults can be injected.
 */
@Component
public class HttpClients {
    private final RestClient payment;
    private final RestClient stock;

    public HttpClients(
            @Value("${app.payment.url}") String paymentUrl,
            @Value("${app.payment.connect-timeout:1s}") Duration paymentConnect,
            @Value("${app.payment.read-timeout:3s}") Duration paymentRead,
            @Value("${app.stock.url}") String stockUrl,
            @Value("${app.stock.read-timeout:2s}") Duration stockRead) {
        this.payment = build(paymentUrl, paymentConnect, paymentRead);
        this.stock = build(stockUrl, Duration.ofSeconds(1), stockRead);
    }

    private static RestClient build(String url, Duration connect, Duration read) {
        HttpClient http = HttpClient.newBuilder().connectTimeout(connect).version(HttpClient.Version.HTTP_1_1).build();
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(read);
        return RestClient.builder().baseUrl(url).requestFactory(factory).build();
    }

    public RestClient payment() {
        return payment;
    }

    public RestClient stock() {
        return stock;
    }
}

package com.shop.order;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "payment", path = "/payments")
public interface PaymentClient {
    @PostMapping("/approve")
    PaymentResult approve(@RequestBody PaymentRequest req);
}

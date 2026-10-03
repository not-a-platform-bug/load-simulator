package com.shop.order;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
    private final OrderService orderService;
    private final ProductRepository productRepository;

    public OrderController(OrderService orderService, ProductRepository productRepository) {
        this.orderService = orderService;
        this.productRepository = productRepository;
    }

    @PostMapping
    public OrderDto create(@RequestBody CreateOrder req) {
        return orderService.place(req);
    }

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable Long id) {
        // a comment with paymentClient.approve( that must be ignored
        return orderService.find(id);
    }

    @GetMapping("/admin/report")
    public Report report() {
        return new Report(productRepository.findAll());
    }
}

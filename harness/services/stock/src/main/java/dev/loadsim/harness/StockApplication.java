package dev.loadsim.harness;

import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class StockApplication {
    public static void main(String[] args) {
        SpringApplication.run(StockApplication.class, args);
    }
}

@RestController
class StockController {
    private final JdbcTemplate jdbc;

    StockController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/stocks/{id}")
    public Map<String, Object> stock(@PathVariable long id) {
        Integer q = jdbc.queryForObject("SELECT quantity FROM stock WHERE sku = ?", Integer.class, 1 + id % 1000);
        return Map.of("sku", id, "quantity", q == null ? 0 : q);
    }
}

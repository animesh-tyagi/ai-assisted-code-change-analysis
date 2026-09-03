package com.impact.parser.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /v1/version} (ARCHITECTURE.md §8). */
@RestController
public class VersionController {

    private final ParserProperties properties;

    public VersionController(ParserProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/v1/version")
    public VersionResponse version() {
        return VersionResponse.from(properties);
    }
}

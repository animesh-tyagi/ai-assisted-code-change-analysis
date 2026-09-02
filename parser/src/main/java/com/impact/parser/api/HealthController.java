package com.impact.parser.api;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /healthz}, {@code GET /readyz} (ARCHITECTURE.md §8).
 *
 * <p>"{@code readyz} fails if the shared volume is not mounted." This service
 * does not itself own a fixed mount — {@code workspacePath} arrives per request
 * (D1) — so what {@code readyz} checks is the container's own mount point for
 * that volume, configured via {@code parser.workspace-root}. When it is unset,
 * as in local dev and every test in this suite, there is nothing to check and
 * {@code readyz} reports ready; deployment wiring is what gives this property a
 * real value.
 */
@RestController
public class HealthController {

    private final String workspaceRoot;

    public HealthController(@Value("${parser.workspace-root:}") String workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
    }

    @GetMapping("/healthz")
    public Map<String, String> healthz() {
        // Liveness: the process is up and answering. No dependency to check —
        // this service is stateless and has none (D1).
        return Map.of("status", "ok");
    }

    @GetMapping("/readyz")
    public ResponseEntity<Map<String, String>> readyz() {
        if (workspaceRoot.isBlank()) {
            return ResponseEntity.ok(Map.of("status", "ok"));
        }
        boolean mounted = Files.isDirectory(Path.of(workspaceRoot));
        if (mounted) {
            return ResponseEntity.ok(Map.of("status", "ok"));
        }
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("status", "not ready", "reason", "workspace root not mounted: " + workspaceRoot));
    }
}

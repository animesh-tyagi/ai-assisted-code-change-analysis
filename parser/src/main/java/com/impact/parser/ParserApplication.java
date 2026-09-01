package com.impact.parser;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point for the parser service.
 *
 * <p>This service is the only component that knows Java. It is deliberately
 * stateless: no database, no git, no network egress. It reads a worktree path on
 * the shared volume that the Node worker prepared and returns JSON
 * (ARCHITECTURE.md section 8).
 *
 * <p>Its response is a <em>pure function</em> of (workspace contents, mode, files,
 * options). That purity is a test invariant, not an aspiration — graph versions
 * must be reproducible, so identical input has to produce byte-identical output.
 *
 * <p>Build order (BUILD_PLAN Step 2): a CLI lands first so the edges can be
 * eyeballed on code we know, and the HTTP layer wraps it afterwards.
 */
@SpringBootApplication
public class ParserApplication {

    public static void main(String[] args) {
        SpringApplication.run(ParserApplication.class, args);
    }
}

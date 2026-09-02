package com.impact.parser;

import com.impact.parser.api.ParserProperties;
import com.impact.parser.cli.ParseCommand;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

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
@EnableConfigurationProperties(ParserProperties.class)
public class ParserApplication {

    public static void main(String[] args) {
        // One-shot CLI when --dir is given, web service otherwise. The CLI runs
        // without starting Spring at all: it needs no beans, and booting a web
        // server to print JSON to stdout would only add latency and noise to the
        // thing BUILD_PLAN wants used for eyeballing edges.
        if (ParseCommand.isCliInvocation(args)) {
            System.exit(ParseCommand.run(args));
        }
        SpringApplication.run(ParserApplication.class, args);
    }
}

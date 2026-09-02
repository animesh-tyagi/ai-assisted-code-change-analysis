package com.impact.parser.cli;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The CLI/server switch.
 *
 * <p>Getting this wrong is not cosmetic: matching only {@code --dir} meant
 * {@code --summary} alone fell through to {@code SpringApplication.run}, which
 * bound a port and blocked. To an operator that reads as an unexplained hang, not
 * a usage error.
 */
class ParseCommandTest {

    @Test
    @DisplayName("any CLI flag selects the CLI, so a missing --dir reports usage instead of booting a server")
    void everyCliFlagSelectsTheCli() {
        assertThat(ParseCommand.isCliInvocation(new String[] {"--dir", "/x"})).isTrue();
        assertThat(ParseCommand.isCliInvocation(new String[] {"--summary"})).isTrue();
        assertThat(ParseCommand.isCliInvocation(new String[] {"--out", "x.json"})).isTrue();
        assertThat(ParseCommand.isCliInvocation(new String[] {"--files", "a.java"})).isTrue();
        assertThat(ParseCommand.isCliInvocation(new String[] {"--include-tests"})).isTrue();
    }

    @Test
    @DisplayName("server arguments still start the server")
    void serverArgumentsAreNotClaimed() {
        assertThat(ParseCommand.isCliInvocation(new String[] {})).isFalse();
        assertThat(ParseCommand.isCliInvocation(new String[] {"--server.port=9090"})).isFalse();
        assertThat(ParseCommand.isCliInvocation(new String[] {"--spring.profiles.active=dev"}))
                .isFalse();
    }

    @Test
    @DisplayName("a CLI invocation with no --dir exits 2 rather than hanging")
    void missingDirExitsWithUsage() {
        assertThat(ParseCommand.run(new String[] {"--summary"})).isEqualTo(2);
    }
}

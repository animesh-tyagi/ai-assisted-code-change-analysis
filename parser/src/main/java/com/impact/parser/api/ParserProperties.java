package com.impact.parser.api;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Binds the {@code parser.*} keys from {@code application.yml}, which Maven
 * resource filtering stamps from the POM at build time.
 *
 * <p>Reported by {@code GET /v1/version} and recorded on every graph version
 * (ARCHITECTURE §7's {@code parserVersion}/{@code ruleVersion}), so a parser
 * upgrade — in particular a change to a Spring inference rule — invalidates
 * graphs deliberately instead of silently mixing analyses produced under
 * different rules.
 */
@ConfigurationProperties(prefix = "parser")
public record ParserProperties(String version, String ruleVersion, String javaparserVersion) {}

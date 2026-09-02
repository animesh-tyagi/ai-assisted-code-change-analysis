package com.impact.parser.api;

/** Body for the request-level failures of §8 (400/404/422) — never for a 500. */
public record ErrorResponse(String error) {}

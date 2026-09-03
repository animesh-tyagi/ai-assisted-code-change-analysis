package com.impact.parser.api;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.impact.parser.extract.ParseError;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.test.web.servlet.result.MockMvcResultMatchers;

/**
 * The §8 500 wiring, tested at the controller level with {@link ParseService}
 * mocked out.
 *
 * <p>Forcing a <em>genuine</em> internal failure through the real extraction
 * pipeline is, deliberately, hard: {@code GraphExtractor} catches per-file and
 * per-declaration so that one bad input degrades to a {@code ParseError} rather
 * than an exception (CLAUDE.md — never let a broad catch hide a defect, but also
 * never let one bad file cost the whole run). Reaching the code path this test
 * checks would mean staging a filesystem race between the outer discovery probe
 * and the async {@code compute()} call, which would make the test racy without
 * proving anything the JDK's own documented
 * {@link java.util.concurrent.CompletableFuture#whenComplete} contract doesn't
 * already guarantee.
 *
 * <p>What <em>is</em> worth testing deterministically, and wasn't covered before
 * this fix, is the wiring: when {@link ParseService} signals an internal
 * failure, does the controller actually return {@code 500} with the
 * diagnostics-bearing body §8 specifies — or does it fall through to the
 * default {@code 200} a plain returned object would get? Before this test
 * existed, it fell through: {@link ParseController}'s own comment admitted the
 * failure path was "returned as a 200-shaped ParseResponse."
 */
@WebMvcTest(ParseController.class)
class ParseControllerInternalFailureTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private ParseService parseService;

    @Test
    @DisplayName("an internal failure from ParseService becomes HTTP 500 with the diagnostics body, not 200")
    void internalFailureIs500NotDefaultOk() throws Exception {
        ParseResponse diagnosticsBearingBody =
                new ParseResponse(
                        "req-1",
                        "sha1",
                        "full",
                        List.of(),
                        List.of(),
                        List.of(),
                        List.of(),
                        new ParseDiagnostics(
                                5,
                                0,
                                List.of(new ParseError("/some/workspace", "RuntimeException: boom")),
                                0,
                                0,
                                0.0,
                                0.0,
                                0,
                                0,
                                List.of(),
                                0,
                                0,
                                0));

        when(parseService.parse(any()))
                .thenThrow(
                        new ParseExceptions.InternalFailureException(
                                diagnosticsBearingBody, new RuntimeException("boom")));

        mockMvc
                .perform(
                        MockMvcRequestBuilders.post("/v1/parse")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(
                                        """
                                        {"requestId":"req-1","repoId":"r","sha":"sha1","workspacePath":"/some/workspace","mode":"full"}
                                        """))
                .andExpect(MockMvcResultMatchers.status().isInternalServerError())
                .andExpect(MockMvcResultMatchers.jsonPath("$.diagnostics.parseErrors[0].message").value("RuntimeException: boom"))
                .andExpect(MockMvcResultMatchers.jsonPath("$.requestId").value("req-1"));
    }
}

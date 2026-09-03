package com.impact.parser.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.ResponseEntity;

/**
 * The counterpart claim to {@link SameJvmDeterminismTest}: two <strong>different</strong>
 * repositories, in flight <strong>at the same time</strong> against one live
 * service instance, must not corrupt each other's output.
 *
 * <p>{@link ParseService} constructs a fresh {@code WorkspaceLayout}, a fresh
 * {@code TypeSolver}, and a fresh {@code GraphExtractor} for every call, and
 * shares nothing across requests except its executor and the coalescing map — the
 * coalescing map is itself keyed on {@code (workspacePath, mode, files,
 * includeTestSources)}, so two different repos can never collide onto one entry.
 * This test exercises that design under real concurrency rather than trusting it
 * by inspection: {@link #manyOverlappingRequestsForTwoRepos()} fires two batches
 * of concurrent requests, interleaved via a barrier so they overlap in time, and
 * asserts that every response contains only its own repo's symbols.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ConcurrentRequestIsolationTest {

    @org.springframework.beans.factory.annotation.Autowired private TestRestTemplate restTemplate;

    @TempDir Path repoA;
    @TempDir Path repoB;

    private ExecutorService callers;

    @AfterEach
    void shutdown() {
        if (callers != null) {
            callers.shutdownNow();
        }
    }

    private void write(Path root, String relative, String source) throws IOException {
        Path file = root.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    /**
     * Two repositories with deliberately distinct, greppable identifiers —
     * {@code Alpha*} in one package, {@code Beta*} in a wholly different one — so
     * any cross-contamination is a simple substring check away from detection,
     * rather than something that needs a JSON parse to notice.
     */
    private void writeFixtures() throws IOException {
        write(
                repoA,
                "src/main/java/com/repoalpha/AlphaService.java",
                """
                package com.repoalpha;
                public class AlphaService {
                    public String alphaOnly() { return "a"; }
                }
                """);
        write(
                repoA,
                "src/main/java/com/repoalpha/AlphaController.java",
                """
                package com.repoalpha;
                @RestController
                @RequestMapping("/alpha")
                public class AlphaController {
                    @GetMapping("/x")
                    public String x() { return "x"; }
                }
                """);

        write(
                repoB,
                "src/main/java/com/repobeta/BetaService.java",
                """
                package com.repobeta;
                public class BetaService {
                    public String betaOnly() { return "b"; }
                }
                """);
        write(
                repoB,
                "src/main/java/com/repobeta/BetaController.java",
                """
                package com.repobeta;
                @RestController
                @RequestMapping("/beta")
                public class BetaController {
                    @GetMapping("/y")
                    public String y() { return "y"; }
                }
                """);
    }

    private ParseRequest requestFor(String requestId, Path workspace) {
        return new ParseRequest(requestId, "repo", "sha", workspace.toString(), "full", null, null);
    }

    @Test
    @DisplayName("two repos parsed concurrently never see each other's symbols")
    void manyOverlappingRequestsForTwoRepos() throws Exception {
        writeFixtures();

        int callsPerRepo = 8;
        int totalCalls = callsPerRepo * 2;
        callers = Executors.newFixedThreadPool(totalCalls);
        // A barrier so requests genuinely overlap rather than happening to run
        // one after another because the thread pool scheduled them that way —
        // every caller blocks here until all are ready, then all fire together.
        CountDownLatch start = new CountDownLatch(1);

        List<CompletableFuture<ResponseEntity<String>>> alphaCalls =
                IntStream.range(0, callsPerRepo)
                        .mapToObj(
                                i ->
                                        CompletableFuture.supplyAsync(
                                                () -> {
                                                    await(start);
                                                    return restTemplate.postForEntity(
                                                            "/v1/parse", requestFor("alpha-" + i, repoA), String.class);
                                                },
                                                callers))
                        .toList();
        List<CompletableFuture<ResponseEntity<String>>> betaCalls =
                IntStream.range(0, callsPerRepo)
                        .mapToObj(
                                i ->
                                        CompletableFuture.supplyAsync(
                                                () -> {
                                                    await(start);
                                                    return restTemplate.postForEntity(
                                                            "/v1/parse", requestFor("beta-" + i, repoB), String.class);
                                                },
                                                callers))
                        .toList();

        start.countDown();

        for (var future : alphaCalls) {
            ResponseEntity<String> response = future.get(60, TimeUnit.SECONDS);
            assertAlphaOnly(response);
        }
        for (var future : betaCalls) {
            ResponseEntity<String> response = future.get(60, TimeUnit.SECONDS);
            assertBetaOnly(response);
        }
    }

    private static void assertAlphaOnly(ResponseEntity<String> response) {
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        String body = response.getBody();
        assertThat(body).as("alpha response must contain its own symbols").contains("AlphaService", "repoalpha");
        assertThat(body)
                .as("alpha response must NEVER contain beta's symbols — cross-request corruption")
                .doesNotContain("BetaService", "repobeta", "betaOnly");
    }

    private static void assertBetaOnly(ResponseEntity<String> response) {
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        String body = response.getBody();
        assertThat(body).as("beta response must contain its own symbols").contains("BetaService", "repobeta");
        assertThat(body)
                .as("beta response must NEVER contain alpha's symbols — cross-request corruption")
                .doesNotContain("AlphaService", "repoalpha", "alphaOnly");
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException(e);
        }
    }

    @Test
    @DisplayName("identical concurrent requests for the SAME repo coalesce without cross-contaminating a different repo in flight")
    void coalescingDoesNotLeakAcrossRepos() throws Exception {
        writeFixtures();
        callers = Executors.newFixedThreadPool(6);
        CountDownLatch start = new CountDownLatch(1);

        // Three identical requests for repo A (should coalesce onto one parse)
        // fired alongside one request for repo B — the coalescing key must keep
        // these on separate futures.
        List<CompletableFuture<ResponseEntity<String>>> alpha =
                IntStream.range(0, 3)
                        .mapToObj(
                                i ->
                                        CompletableFuture.supplyAsync(
                                                () -> {
                                                    await(start);
                                                    return restTemplate.postForEntity(
                                                            "/v1/parse", requestFor("alpha-coalesce-" + i, repoA), String.class);
                                                },
                                                callers))
                        .toList();
        CompletableFuture<ResponseEntity<String>> beta =
                CompletableFuture.supplyAsync(
                        () -> {
                            await(start);
                            return restTemplate.postForEntity("/v1/parse", requestFor("beta-solo", repoB), String.class);
                        },
                        callers);

        start.countDown();

        for (var future : alpha) {
            ResponseEntity<String> response = future.get(60, TimeUnit.SECONDS);
            assertAlphaOnly(response);
            // Each caller gets its own requestId back even though the underlying
            // parse may have been shared with another caller — see ParseService's
            // Javadoc on why the envelope is rebuilt per caller.
            assertThat(response.getBody()).contains("\"requestId\":\"alpha-coalesce-");
        }
        ResponseEntity<String> betaResponse = beta.get(60, TimeUnit.SECONDS);
        assertBetaOnly(betaResponse);
        assertThat(betaResponse.getBody()).contains("\"requestId\":\"beta-solo\"");
    }
}

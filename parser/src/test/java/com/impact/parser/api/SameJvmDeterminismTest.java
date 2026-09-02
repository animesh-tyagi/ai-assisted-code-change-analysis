package com.impact.parser.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.ResponseEntity;

/**
 * Proves §8 purity <em>within a single running service instance</em>, which is a
 * different claim from what {@code RealRepoExtractionTest}'s cross-process check
 * proves.
 *
 * <p>The bug that motivated CLAUDE.md's determinism rules — {@code Map.copyOf}'s
 * per-JVM random salt — could <strong>never</strong> have been caught by a test
 * like this one, because the salt is fixed for the life of one JVM: two calls in
 * the same process always agreed even while it was broken. What a same-JVM test
 * catches instead is the class of bug that a cross-process test cannot see at
 * all: state that leaks <em>between requests inside one live service</em> — a
 * cached {@code TypeSolver}, a JavaParser {@code ParserConfiguration} reused
 * across calls, a coalescing-map entry that outlives the request it was built
 * for. {@link ParseService}'s Javadoc names this explicitly as the risk this
 * guards against.
 *
 * <p>Runs the real Spring context and hits the real HTTP endpoint — not
 * {@link ParseService} directly — so the check covers the whole request path
 * Jackson serialisation included, not just the extraction pipeline.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SameJvmDeterminismTest {

    @org.springframework.beans.factory.annotation.Autowired private TestRestTemplate restTemplate;

    @TempDir Path repo;

    /** Strips the one field allowed to legitimately vary between identical calls. */
    private static final Pattern DURATION_MS = Pattern.compile("\"durationMs\"\\s*:\\s*\\d+");

    @BeforeEach
    void writeFixture() throws IOException {
        // A deliberately varied fixture — an interface with two implementations,
        // a route, a scheduled job — so the request exercises every sorted-output
        // path (edges, surfaces, annotation members) in one call rather than just
        // the plain function list.
        write(
                "src/main/java/com/acme/Strategy.java",
                """
                package com.acme;
                public interface Strategy {
                    void execute(String input);
                }
                """);
        write(
                "src/main/java/com/acme/AlphaStrategy.java",
                """
                package com.acme;
                public class AlphaStrategy implements Strategy {
                    public void execute(String input) {}
                }
                """);
        write(
                "src/main/java/com/acme/BetaStrategy.java",
                """
                package com.acme;
                public class BetaStrategy implements Strategy {
                    public void execute(String input) {}
                }
                """);
        write(
                "src/main/java/com/acme/Controller.java",
                """
                package com.acme;
                @RestController
                @RequestMapping("/api")
                public class Controller {
                    @GetMapping("/things/{id}")
                    public String get(int id) { return "x"; }
                }
                """);
        write(
                "src/main/java/com/acme/Job.java",
                """
                package com.acme;
                public class Job {
                    @Scheduled(fixedRate = 5000, initialDelay = 10)
                    void tick() {}
                }
                """);
    }

    private void write(String relative, String source) throws IOException {
        Path file = repo.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    @Test
    @DisplayName("two full-mode requests for the same commit, same live instance, byte-identical")
    void sequentialCallsInOneInstanceAreByteIdentical() {
        ParseRequest request =
                new ParseRequest("req-1", "repo-1", "deadbeef", repo.toString(), "full", null, null);

        ResponseEntity<String> first = restTemplate.postForEntity("/v1/parse", withSameId(request, "same-id"), String.class);
        ResponseEntity<String> second = restTemplate.postForEntity("/v1/parse", withSameId(request, "same-id"), String.class);

        assertThat(first.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(second.getStatusCode().is2xxSuccessful()).isTrue();

        String bodyA = normalize(first.getBody());
        String bodyB = normalize(second.getBody());

        assertThat(bodyB)
                .as(
                        "a second call, in the SAME service instance, must serialise identically to"
                                + " the first — any difference here is state leaking between requests")
                .isEqualTo(bodyA);
    }

    @Test
    @DisplayName("ten repeated calls stay identical — not just the second one")
    void repeatedCallsStayIdentical() {
        ParseRequest request =
                new ParseRequest("req-n", "repo-1", "deadbeef", repo.toString(), "full", null, null);

        String baseline = normalize(restTemplate.postForEntity("/v1/parse", request, String.class).getBody());

        for (int i = 0; i < 9; i++) {
            String body = normalize(restTemplate.postForEntity("/v1/parse", request, String.class).getBody());
            assertThat(body).as("call #%d diverged from the baseline", i + 2).isEqualTo(baseline);
        }
    }

    private static ParseRequest withSameId(ParseRequest base, String id) {
        return new ParseRequest(id, base.repoId(), base.sha(), base.workspacePath(), base.mode(), base.files(), base.options());
    }

    private static String normalize(String body) {
        return DURATION_MS.matcher(body).replaceAll("\"durationMs\":0");
    }
}

package com.impact.parser.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;

/**
 * The provisional scale ceiling (ARCHITECTURE §16.1 Q9; basis in DECISIONS
 * "Provisional scale ceiling"). The property is overridden to a tiny threshold
 * here so the guard can be exercised with a handful of files rather than
 * regenerating the 519-file measurement this session already took against
 * macrozheng/mall.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "parser.scale.max-files=3")
class ScaleCeilingTest {

    @Autowired private TestRestTemplate restTemplate;

    @TempDir Path repo;

    private void write(String relative, String source) throws IOException {
        Path file = repo.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    private ParseRequest fullRequest(String id) {
        return new ParseRequest(id, "repo", "sha", repo.toString(), "full", null, null);
    }

    @Test
    @DisplayName("at or under the ceiling, full mode succeeds")
    void atCeilingSucceeds() throws IOException {
        write("src/main/java/com/acme/A.java", "package com.acme; class A {}");
        write("src/main/java/com/acme/B.java", "package com.acme; class B {}");
        write("src/main/java/com/acme/C.java", "package com.acme; class C {}");

        var response = restTemplate.postForEntity("/v1/parse", fullRequest("r1"), ParseResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    @DisplayName("over the ceiling, full mode is refused with 413 and an actionable message")
    void overCeilingIs413() throws IOException {
        write("src/main/java/com/acme/A.java", "package com.acme; class A {}");
        write("src/main/java/com/acme/B.java", "package com.acme; class B {}");
        write("src/main/java/com/acme/C.java", "package com.acme; class C {}");
        write("src/main/java/com/acme/D.java", "package com.acme; class D {}");

        var response = restTemplate.postForEntity("/v1/parse", fullRequest("r2"), ErrorResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
        assertThat(response.getBody().error())
                .as("the message must point somewhere actionable, not just say no")
                .contains("scale ceiling")
                .containsIgnoringCase("subset");
    }

    @Test
    @DisplayName("subset mode stays cheap regardless of total repo size — only the named files are gated")
    void subsetModeIsNotGatedByTotalRepoSize() throws IOException {
        // Five files on disk — over the ceiling of 3 — but the request only
        // names two of them. This is the property the guard exists to protect:
        // a huge repo must not become impossible to analyse a small PR against.
        write("src/main/java/com/acme/A.java", "package com.acme; class A { void a() {} }");
        write("src/main/java/com/acme/B.java", "package com.acme; class B { void b() {} }");
        write("src/main/java/com/acme/C.java", "package com.acme; class C {}");
        write("src/main/java/com/acme/D.java", "package com.acme; class D {}");
        write("src/main/java/com/acme/E.java", "package com.acme; class E {}");

        var request =
                new ParseRequest(
                        "r3",
                        "repo",
                        "sha",
                        repo.toString(),
                        "subset",
                        List.of("src/main/java/com/acme/A.java", "src/main/java/com/acme/B.java"),
                        null);

        var response = restTemplate.postForEntity("/v1/parse", request, ParseResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().functions()).extracting(f -> f.methodName()).containsExactly("a", "b");
    }
}

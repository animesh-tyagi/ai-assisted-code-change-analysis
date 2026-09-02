package com.impact.parser.api;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/** The §8 HTTP contract: status codes, error shapes, and the two read-only endpoints. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ParseControllerTest {

    @org.springframework.beans.factory.annotation.Autowired private TestRestTemplate restTemplate;

    @TempDir Path repo;

    private void write(String relative, String source) throws IOException {
        Path file = repo.resolve(relative);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    @Nested
    @DisplayName("POST /v1/parse")
    class Parse {

        @Test
        @DisplayName("full mode against a real workspace returns 200 with the graph")
        void fullModeSucceeds() throws IOException {
            write("src/main/java/com/acme/A.java", "package com.acme; class A { void go() {} }");

            var response =
                    restTemplate.postForEntity(
                            "/v1/parse",
                            new ParseRequest("r1", "repo", "sha1", repo.toString(), "full", null, null),
                            ParseResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(response.getBody()).isNotNull();
            assertThat(response.getBody().functions())
                    .extracting(f -> f.methodName())
                    .contains("go");
            assertThat(response.getBody().diagnostics().nonExternalUnresolvedRate()).isEqualTo(0.0);
        }

        @Test
        @DisplayName("subset mode extracts only the named files")
        void subsetModeNarrowsExtraction() throws IOException {
            write("src/main/java/com/acme/A.java", "package com.acme; class A { void a() {} }");
            write("src/main/java/com/acme/B.java", "package com.acme; class B { void b() {} }");

            var response =
                    restTemplate.postForEntity(
                            "/v1/parse",
                            new ParseRequest(
                                    "r2",
                                    "repo",
                                    "sha1",
                                    repo.toString(),
                                    "subset",
                                    java.util.List.of("src/main/java/com/acme/A.java"),
                                    null),
                            ParseResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(response.getBody().functions()).extracting(f -> f.methodName()).containsExactly("a");
        }

        @Test
        @DisplayName("missing mode is a 400 with an ErrorResponse body")
        void missingModeIs400() throws IOException {
            write("src/main/java/com/acme/A.java", "package com.acme; class A {}");

            var response =
                    restTemplate.postForEntity(
                            "/v1/parse",
                            new ParseRequest("r3", "repo", "sha1", repo.toString(), null, null, null),
                            ErrorResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(response.getBody().error()).contains("mode");
        }

        @Test
        @DisplayName("subset mode with no files is a 400")
        void subsetWithNoFilesIs400() throws IOException {
            write("src/main/java/com/acme/A.java", "package com.acme; class A {}");

            var response =
                    restTemplate.postForEntity(
                            "/v1/parse",
                            new ParseRequest("r4", "repo", "sha1", repo.toString(), "subset", null, null),
                            ErrorResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(response.getBody().error()).contains("files");
        }

        @Test
        @DisplayName("a workspacePath that does not exist is a 404")
        void missingWorkspaceIs404() {
            var response =
                    restTemplate.postForEntity(
                            "/v1/parse",
                            new ParseRequest(
                                    "r5",
                                    "repo",
                                    "sha1",
                                    repo.resolve("does-not-exist").toString(),
                                    "full",
                                    null,
                                    null),
                            ErrorResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        }

        @Test
        @DisplayName("a workspace with no Java source roots is a 422")
        void noSourceRootsIs422() throws IOException {
            Files.writeString(repo.resolve("README.md"), "nothing java here");

            var response =
                    restTemplate.postForEntity(
                            "/v1/parse",
                            new ParseRequest("r6", "repo", "sha1", repo.toString(), "full", null, null),
                            ErrorResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        }
    }

    @Nested
    @DisplayName("GET /v1/version")
    class Version {

        @Test
        @DisplayName("reports parser, rule, and JavaParser versions")
        void reportsVersions() {
            ResponseEntity<VersionResponse> response =
                    restTemplate.getForEntity("/v1/version", VersionResponse.class);

            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat(response.getBody().parserVersion()).isNotBlank();
            assertThat(response.getBody().ruleVersion()).isNotBlank();
            assertThat(response.getBody().javaParserVersion()).isNotBlank();
        }
    }

    @Nested
    @DisplayName("health checks")
    class Health {

        @Test
        @DisplayName("GET /healthz is always ok")
        void healthzOk() {
            var response = restTemplate.getForEntity("/healthz", java.util.Map.class);
            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        }

        @Test
        @DisplayName("GET /readyz is ok when no workspace root is configured")
        void readyzOkWithNoConfiguredRoot() {
            var response = restTemplate.getForEntity("/readyz", java.util.Map.class);
            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        }
    }
}

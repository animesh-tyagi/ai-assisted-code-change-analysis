package com.impact.parser.resolve;

import static org.assertj.core.api.Assertions.assertThat;

import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.extract.GraphExtractor;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.GraphEdge;
import com.impact.parser.graph.UnresolvedReason;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Guards the resolution boundary that section 8's determinism rests on.
 *
 * <p>This service is a Spring Boot application: Spring, Jackson and friends are on
 * its own classpath. {@code ReflectionTypeSolver} resolves through that class
 * loader, so constructed with {@code ALL_CLASSES} it would resolve the
 * <em>analysed</em> repository's Spring calls against <em>our</em> dependency
 * versions.
 *
 * <p>Two things break if that happens. The parse response stops being a pure
 * function of (workspace, mode, files, options) — it becomes a function of our
 * pom as well, so graph versions are no longer reproducible. And bumping a
 * dependency here would silently change the graph produced for someone else's
 * repository.
 *
 * <p>So a Spring call in analysed code must land in bucket 3 of section 6.5
 * ({@code unresolved:} with {@code external_type}) and never in bucket 1
 * ({@code calls}) or bucket 2 (counted as external).
 */
class ReflectionTypeSolverScopeTest {

    @TempDir Path tempDir;

    private void writeSource(String relativePath, String source) throws IOException {
        Path file = tempDir.resolve(relativePath);
        Files.createDirectories(file.getParent());
        Files.writeString(file, source);
    }

    private ExtractionResult extract() {
        WorkspaceLayout layout = SourceRootDiscovery.discover(tempDir, false);
        var solver = new SourceAndJdkTypeSolverFactory().create(layout);
        return new GraphExtractor(solver).extract(layout, SourceRootDiscovery.javaFiles(layout));
    }

    @Test
    @DisplayName("a Spring call in analysed code is unresolved, not resolved via our own classpath")
    void springTypesOnOurClasspathDoNotLeakIntoAnalysis() throws IOException {
        // org.springframework.util.StringUtils really is on this service's
        // classpath. If ReflectionTypeSolver were ALL_CLASSES, the call below would
        // resolve and be counted as external (bucket 2) instead of unresolved.
        writeSource(
                "src/main/java/com/acme/Svc.java",
                """
                package com.acme;
                import org.springframework.util.StringUtils;
                class Svc {
                    boolean check(String value) {
                        return StringUtils.hasText(value);
                    }
                }
                """);

        ExtractionResult result = extract();

        assertThat(result.edges())
                .as("the Spring call must produce an unresolved edge")
                .anySatisfy(
                        edge -> {
                            assertThat(edge.type()).isEqualTo(EdgeType.UNRESOLVED);
                            assertThat(edge.reason()).isEqualTo(UnresolvedReason.EXTERNAL_TYPE);
                            assertThat(edge.to()).contains("hasText");
                        });

        assertThat(result.edges())
                .as("and must not have been graphed as a calls edge")
                .noneMatch(e -> e.type() == EdgeType.CALLS && e.to().contains("springframework"));
    }

    @Test
    @DisplayName("the JDK still resolves — this narrows the classpath, it does not disable reflection")
    void jdkTypesStillResolve() throws IOException {
        writeSource(
                "src/main/java/com/acme/Svc.java",
                """
                package com.acme;
                import java.util.ArrayList;
                class Svc {
                    int count() {
                        return new ArrayList<String>().size();
                    }
                }
                """);

        ExtractionResult result = extract();

        // Resolved to the JDK, therefore bucket 2: counted, not graphed, and not
        // mistaken for a resolution failure.
        assertThat(result.externalCalls()).isPositive();
        assertThat(result.edges()).noneMatch(GraphEdge::isUnresolved);
    }
}

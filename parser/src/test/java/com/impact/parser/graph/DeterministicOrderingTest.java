package com.impact.parser.graph;

import static org.assertj.core.api.Assertions.assertThat;

import com.impact.parser.extract.ExtractionResult;
import com.impact.parser.extract.GraphExtractor;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Guards §8 purity against a failure mode that <em>no ordinary in-process test can
 * catch</em>.
 *
 * <p>{@code Map.copyOf} returns an immutable map whose iteration order is derived
 * from a random salt chosen once per JVM. Inside a single JVM that salt is
 * constant, so {@code extract().equals(extract())} passes and every determinism
 * test looks green — while two separate CLI invocations on the same commit emit
 * different bytes. That is a graph-version reproducibility bug, and it shipped
 * silently until the CLI compared two real runs.
 *
 * <p>Equality cannot express the invariant, because equal maps may still iterate
 * differently. So these tests assert the property that actually matters:
 * <strong>iteration order is sorted</strong>, which is stable by construction
 * across processes.
 */
class DeterministicOrderingTest {

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

    private static void assertIteratesSorted(Map<String, String> map, String what) {
        List<String> actual = new ArrayList<>(map.keySet());
        List<String> sorted = new ArrayList<>(new TreeMap<>(map).keySet());
        assertThat(actual)
                .as(
                        what
                                + " must iterate in sorted order — an unordered immutable map"
                                + " would serialise differently in a different JVM")
                .isEqualTo(sorted);
    }

    @Test
    @DisplayName("annotation members iterate in sorted order, not salted order")
    void annotationValuesAreSorted() throws IOException {
        // Enough members that an arbitrary order is very unlikely to be sorted by
        // chance: 5 keys give a 1-in-120 coincidence.
        writeSource(
                "src/main/java/com/acme/Mapped.java",
                """
                package com.acme;
                class Mapped {
                    @Mapping(target = "id", source = "ownerId", ignore = "true",
                             defaultValue = "x", qualifiedByName = "y")
                    void map() {}
                }
                """);

        var annotations = extract().functions().getFirst().annotations();

        assertThat(annotations).isNotEmpty();
        assertIteratesSorted(annotations.getFirst().values(), "AnnotationRef.values()");
        assertThat(annotations.getFirst().values())
                .containsKeys("defaultValue", "ignore", "qualifiedByName", "source", "target");
    }

    @Test
    @DisplayName("surface attributes iterate in sorted order")
    void surfaceAttrsAreSorted() throws IOException {
        writeSource(
                "src/main/java/com/acme/Job.java",
                """
                package com.acme;
                class Job {
                    @Scheduled(fixedRate = 5000, initialDelay = 10, zone = "UTC")
                    void tick() {}
                }
                """);

        var job =
                extract().surfaces().stream()
                        .filter(s -> s.kind() == SurfaceKind.SCHEDULED_JOB)
                        .findFirst()
                        .orElseThrow();

        assertIteratesSorted(job.attrs(), "Surface.attrs()");
    }

    @Test
    @DisplayName("nodes, edges and surfaces all come back sorted")
    void topLevelListsAreSorted() throws IOException {
        writeSource(
                "src/main/java/com/acme/Z.java",
                """
                package com.acme;
                @RequestMapping("/z")
                class Z {
                    @GetMapping("/b") void zebra() { apple(); }
                    @GetMapping("/a") void apple() {}
                }
                """);

        ExtractionResult result = extract();

        assertThat(result.functions()).extracting(ParsedFunction::key).isSorted();
        assertThat(result.surfaces()).extracting(Surface::key).isSorted();
        // Edges sort by (from, to, type) — assert the primary key at minimum.
        assertThat(result.edges()).extracting(GraphEdge::from).isSorted();
    }
}

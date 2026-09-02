package com.impact.parser.extract;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.resolve.SourceAndJdkTypeSolverFactory;
import com.impact.parser.workspace.SourceRootDiscovery;
import com.impact.parser.workspace.WorkspaceLayout;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Extraction against the two real validation repos (DECISIONS, "Validation &amp;
 * eval repos"). Author-written fixtures are regression tests; these are the
 * measurements that say whether the parser works on genuine code.
 *
 * <p>Each test skips when its repo is not on this machine, so the suite stays
 * green for anyone who has not cloned them. Point them at a checkout with:
 *
 * <pre>
 * mvn test -Dvalidation.observability=/path/to/Dummy -Dvalidation.petclinic=/path/to/spring-petclinic-rest
 * </pre>
 */
class RealRepoExtractionTest {

    private static Path repoFromProperty(String property) {
        String configured = System.getProperty(property);
        assumeTrue(configured != null && !configured.isBlank(), property + " not set — skipping");
        Path path = Path.of(configured);
        assumeTrue(Files.isDirectory(path), configured + " is not a directory — skipping");
        return path;
    }

    private static ExtractionResult extract(Path repo) {
        WorkspaceLayout layout = SourceRootDiscovery.discover(repo, false);
        var solver = new SourceAndJdkTypeSolverFactory().create(layout);
        return new GraphExtractor(solver).extract(layout, SourceRootDiscovery.javaFiles(layout));
    }

    private static void report(String label, Path repo, ExtractionResult result, long millis) {
        System.out.printf(
                "%n=== %s ===%n"
                        + "  files parsed        : %d%n"
                        + "  parse errors        : %d%n"
                        + "  functions           : %d%n"
                        + "  unresolved params   : %d (%.1f%% of all parameters)%n"
                        + "  edges               : %d  (calls %d, implements %d, overrides %d, unresolved %d)%n"
                        + "  unresolvedRate      : %.1f%%  [section 6.5 health metric]%n"
                        + "  external calls      : %d  (resolved but out of scope, not graphed)%n"
                        + "  ambiguous overloads : %d%n"
                        + "  extraction time     : %d ms%n",
                label,
                result.filesParsed(),
                result.parseErrors().size(),
                result.functions().size(),
                result.unresolvedParamTypes(),
                result.unresolvedParamRate() * 100,
                result.edges().size(),
                countOf(result, EdgeType.CALLS),
                countOf(result, EdgeType.IMPLEMENTS),
                countOf(result, EdgeType.OVERRIDES),
                countOf(result, EdgeType.UNRESOLVED),
                result.unresolvedRate() * 100,
                result.externalCalls(),
                result.ambiguousOverloads().size(),
                millis);

        result.parseErrors().forEach(e -> System.out.printf("  PARSE ERROR %s: %s%n", e.filePath(), e.message()));

        System.out.printf("  surfaces            : %d%n", result.surfaces().size());
        result.surfaces().stream()
                .collect(Collectors.groupingBy(x -> x.kind().wireName(), Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .forEach(e -> System.out.printf("    %-20s %d%n", e.getKey(), e.getValue()));
        System.out.println("  sample routes:");
        result.surfaces().stream()
                .filter(x -> x.kind() == com.impact.parser.graph.SurfaceKind.HTTP_ROUTE)
                .limit(6)
                .forEach(x -> System.out.printf("    %s%n", x.key()));

        System.out.println("  unresolved edges by reason:");
        result.edges().stream()
                .filter(e -> e.type() == EdgeType.UNRESOLVED)
                .collect(Collectors.groupingBy(e -> String.valueOf(e.reason()), Collectors.counting()))
                .entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .forEach(e -> System.out.printf("    %-24s %d%n", e.getKey(), e.getValue()));

        long externalType = result.edges().stream()
                .filter(e -> e.type() == EdgeType.UNRESOLVED)
                .filter(e -> String.valueOf(e.reason()).equals("EXTERNAL_TYPE"))
                .count();
        long nonExternal = result.unresolvedEdges() - externalType;
        System.out.printf(
                "  SLICED: external_type %d (%.1f%% of edges) | NON-external unresolved %d (%.1f%% of edges)  <-- health signal%n",
                externalType,
                result.edges().isEmpty() ? 0.0 : externalType * 100.0 / result.edges().size(),
                nonExternal,
                result.edges().isEmpty() ? 0.0 : nonExternal * 100.0 / result.edges().size());

        System.out.println("  sample @Override-bearing methods and their outgoing inheritance edges:");
        result.functions().stream()
                .filter(f -> f.hasAnnotation("Override"))
                .limit(6)
                .forEach(f -> {
                    String kinds = result.edges().stream()
                            .filter(e -> e.from().equals(f.key()))
                            .filter(e -> e.type() == EdgeType.OVERRIDES || e.type() == EdgeType.IMPLEMENTS)
                            .map(e -> e.type().wireName() + "->" + e.to())
                            .collect(Collectors.joining(", "));
                    System.out.printf("    %s  [%s]%n", f.key(), kinds.isEmpty() ? "NO INHERITANCE EDGE" : kinds);
                });

        // The most common unresolved types tell us exactly what a classpath-aware
        // TypeSolver would buy — the D2 upgrade trigger, measured not guessed.
        Map<String, Long> unresolvedByType =
                result.functions().stream()
                        .filter(f -> f.unresolvedParamTypes() > 0)
                        .flatMap(f -> f.paramTypes().stream())
                        .filter(t -> !t.startsWith("java.") && !isPrimitive(t))
                        .collect(Collectors.groupingBy(t -> t, Collectors.counting()));

        System.out.println("  most common types on methods with unresolved params:");
        unresolvedByType.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(8)
                .forEach(e -> System.out.printf("    %-60s %d%n", e.getKey(), e.getValue()));
    }

    private static long countOf(ExtractionResult result, EdgeType type) {
        return result.edges().stream().filter(e -> e.type() == type).count();
    }

    private static boolean isPrimitive(String type) {
        return switch (type) {
            case "int", "long", "boolean", "double", "float", "char", "byte", "short", "void" -> true;
            default -> false;
        };
    }

    @Test
    @DisplayName("observability-final: call graph source repo (code the author knows)")
    void extractsObservabilityFinal() {
        Path repo = repoFromProperty("validation.observability");

        long start = System.currentTimeMillis();
        ExtractionResult result = extract(repo);
        long millis = System.currentTimeMillis() - start;

        report("observability-final", repo, result, millis);

        assertThat(result.functions()).isNotEmpty();
        assertThat(result.functions()).extracting(ParsedFunction::key).doesNotHaveDuplicates();
        assertThat(result.parseErrors()).isEmpty();
    }

    @Test
    @DisplayName("spring-petclinic-rest: interface→impl and Spring Data source repo")
    void extractsPetclinicRest() {
        Path repo = repoFromProperty("validation.petclinic");

        long start = System.currentTimeMillis();
        ExtractionResult result = extract(repo);
        long millis = System.currentTimeMillis() - start;

        report("spring-petclinic-rest", repo, result, millis);

        assertThat(result.functions()).isNotEmpty();
        assertThat(result.functions()).extracting(ParsedFunction::key).doesNotHaveDuplicates();
        assertThat(result.parseErrors()).isEmpty();

        // The two constructs this repo was chosen for must both be present as
        // nodes, or phase 5 has nothing real to validate against.
        assertThat(result.functions())
                .as("ClinicService interface methods")
                .anyMatch(f -> f.fqcn().endsWith("service.ClinicService") && f.isInterfaceMethod());
        assertThat(result.functions())
                .as("Spring Data repository methods")
                .anyMatch(f -> f.fqcn().contains("springdatajpa"));
    }

    @Test
    @DisplayName("extraction is byte-identical across runs on real code")
    void isDeterministicOnRealCode() {
        Path repo = repoFromProperty("validation.petclinic");

        ExtractionResult first = extract(repo);
        ExtractionResult second = extract(repo);

        // Section 8 purity, checked against a real tree rather than three files:
        // filesystem walk order and map iteration are the usual sources of drift.
        assertThat(second).isEqualTo(first);
        assertThat(second.functions())
                .isSortedAccordingTo(Comparator.comparing(ParsedFunction::key));
    }
}

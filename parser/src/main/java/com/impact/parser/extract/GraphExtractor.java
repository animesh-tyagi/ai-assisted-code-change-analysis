package com.impact.parser.extract;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.Problem;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.resolution.TypeSolver;
import com.github.javaparser.symbolsolver.JavaSymbolSolver;
import com.impact.parser.graph.EdgeCollector;
import com.impact.parser.graph.SurfaceCollector;
import com.impact.parser.spring.EntryPointRules;
import com.impact.parser.spring.InterfaceDispatchRules;
import com.impact.parser.spring.SpringAnnotations;
import com.impact.parser.spring.SpringDataRules;
import com.impact.parser.graph.ParsedFunction;
import com.impact.parser.workspace.WorkspaceLayout;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns a workspace into nodes and edges — the whole graph the parse response
 * carries (ARCHITECTURE.md section 8).
 *
 * <p>Owns the single parse pass. Each file is read once and handed to both
 * function and edge extraction; parsing petclinic twice would double the cost of
 * every index, and D3's atomic-swap design assumes a full parse is seconds.
 *
 * <p>Two properties this class has to hold:
 *
 * <ol>
 *   <li><strong>Determinism.</strong> The response is a pure function of
 *       (workspace, mode, files, options). Files arrive sorted, nodes and edges
 *       leave sorted, and annotation members sit in sorted maps — so the same
 *       commit always serialises to the same bytes.
 *   <li><strong>Never lose a node.</strong> A file that fails to parse becomes a
 *       {@link ParseError}; a parameter whose type will not resolve falls back to
 *       import-based naming. Both are counted. A missing node is invisible
 *       damage: its method would appear to have no callers, so a change to it
 *       would look harmless.
 * </ol>
 */
public final class GraphExtractor {

    /**
     * Language level used for every parse.
     *
     * <p>Not optional, and not cosmetic. JavaParser's default level predates Java
     * 12, so a single switch expression makes a whole file unparseable — every
     * function in it disappears. That was measured, not theorised: it silently
     * cost one file and nine functions in observability-final until this was set.
     *
     * <p>A newer level parses older sources fine, so this is set high rather than
     * per-repository. It is fixed rather than a request option so that output
     * stays a pure function of its inputs; a per-run language level would make
     * graph versions irreproducible.
     */
    private static final ParserConfiguration.LanguageLevel LANGUAGE_LEVEL =
            ParserConfiguration.LanguageLevel.JAVA_21;

    private final TypeSolver typeSolver;

    public GraphExtractor(TypeSolver typeSolver) {
        this.typeSolver = typeSolver;
    }

    /**
     * Extracts the graph from the given files.
     *
     * <p>{@code files} narrows extraction only. The solver still spans the whole
     * workspace, so subset mode (D4) resolves a call from a touched file into an
     * untouched one exactly as full mode would.
     */
    public ExtractionResult extract(WorkspaceLayout layout, List<Path> files) {
        JavaParser parser = configuredParser();
        List<ParsedFunction> functions = new ArrayList<>();
        List<ParseError> errors = new ArrayList<>();
        EdgeCollector collector = new EdgeCollector();
        SurfaceCollector surfaces = new SurfaceCollector();
        EdgeExtractor.Stats stats = new EdgeExtractor.Stats();
        Map<String, String> keyIndexRef = new HashMap<>();
        EdgeExtractor edgeExtractor = new EdgeExtractor(collector, stats, keyIndexRef, layout.extractionRoots());

        int filesParsed = 0;
        int unresolvedParams = 0;

        // Parsed once, walked twice. Function extraction has to finish for every
        // file before edge extraction starts, because an edge target can live in a
        // file that has not been reached yet and its key must already be known.
        List<ParsedFile> parsed = new ArrayList<>();
        Map<String, String> keyIndex = keyIndexRef;

        for (Path file : files) {
            String relativePath = layout.relativize(file);
            CompilationUnit cu;
            try {
                ParseResult<CompilationUnit> result = parser.parse(file);
                if (!result.isSuccessful() || result.getResult().isEmpty()) {
                    errors.add(new ParseError(relativePath, firstProblem(result.getProblems())));
                    continue;
                }
                cu = result.getResult().get();
            } catch (IOException e) {
                errors.add(new ParseError(relativePath, "could not read file: " + e.getMessage()));
                continue;
            }
            filesParsed++;

            // Computed once per file and shared, so both passes name anonymous
            // classes identically — otherwise a calls edge would point at a node
            // key that functions[] never emitted.
            Map<ObjectCreationExpr, String> anonymousNames = Declarations.anonymousClassNames(cu);

            FunctionExtractor.Result extracted =
                    FunctionExtractor.fromCompilationUnit(cu, relativePath, anonymousNames);
            functions.addAll(extracted.functions());
            errors.addAll(extracted.errors());
            unresolvedParams += extracted.unresolvedParamTypes();
            keyIndex.putAll(extracted.keysByPosition());

            parsed.add(new ParsedFile(cu, relativePath, anonymousNames));
        }

        EntryPointRules entryPoints = new EntryPointRules(collector, surfaces);
        SpringDataRules springData = new SpringDataRules(collector, surfaces);
        // Entity declarations must all be known before any repository is resolved,
        // since the entity commonly lives in a different file from its repository.
        parsed.forEach(file -> springData.indexTypes(file.cu()));

        java.util.Set<String> primaryKeys = new java.util.HashSet<>();
        java.util.Set<String> qualifiedKeys = new java.util.HashSet<>();

        for (ParsedFile file : parsed) {
            try {
                edgeExtractor.extractFrom(file.cu(), file.relativePath(), file.anonymousNames());
                // Spring rules run in the same pass. keyOf is handed the same
                // naming function functions[] used, so a surface can never point at
                // a key no node carries.
                entryPoints.apply(
                        file.cu(),
                        file.relativePath(),
                        method ->
                                Declarations.keyOfIndexed(
                                        method, keyIndexRef, file.anonymousNames()));
                springData.apply(
                        file.cu(),
                        file.relativePath(),
                        method ->
                                Declarations.keyOfIndexed(
                                        method, keyIndexRef, file.anonymousNames()));
                collectSelectors(file, keyIndexRef, primaryKeys, qualifiedKeys);
            } catch (RuntimeException e) {
                // A failure anywhere in this pass (edges, entry points, Spring
                // Data, or selector collection) must not cost us the file's
                // nodes from the first pass. The message says "graph rule"
                // rather than "edge extraction" because all four stages share
                // this one try/catch — a Spring Data failure here is reported
                // the same way as an edge-extraction failure, so it stays
                // accurate rather than pointing at the wrong stage. A failure
                // partway through also means any @Primary/@Qualifier selectors
                // collectSelectors would have found for this file are lost for
                // the whole run; that fails toward InterfaceDispatchRules
                // treating the affected call as ambiguous rather than resolving
                // it — the same safe-by-default outcome the rule already uses
                // when a selector genuinely doesn't disambiguate, not a wrong
                // edge, so it is accepted as a known limitation rather than
                // split into per-stage handling.
                errors.add(
                        new ParseError(
                                file.relativePath(),
                                "graph rule extraction failed: "
                                        + e.getClass().getSimpleName()
                                        + ": "
                                        + e.getMessage()));
            }
        }

        // Interface dispatch is derived from the implements edges already
        // gathered, so it runs once at the end rather than re-walking the source.
        new InterfaceDispatchRules(collector).apply(collector.toList(), primaryKeys, qualifiedKeys);

        functions.sort(Comparator.comparing(ParsedFunction::key));
        errors.sort(Comparator.comparing(ParseError::filePath).thenComparing(ParseError::message));
        List<String> ambiguous = stats.ambiguousOverloadTargets.stream().distinct().sorted().toList();

        return new ExtractionResult(
                List.copyOf(functions),
                collector.toList(),
                surfaces.toList(),
                List.copyOf(errors),
                filesParsed,
                unresolvedParams,
                stats.externalCalls,
                ambiguous,
                stats.failedDeclarations,
                stats.guardedFailures,
                stats.targetsMissingFromIndex);
    }

    /**
     * Records methods whose declaring class carries {@code @Primary} or
     * {@code @Qualifier}, so interface dispatch can narrow candidates. The
     * annotations sit on the class, but selection happens per method.
     *
     * <p>Keys are looked up by position ({@link Declarations#keyOfIndexed}) so
     * the selector key can never disagree with the key {@code functions[]} gave
     * the same method — {@link Declarations#keyOf} recomputes from the AST, which
     * is only safe for a declaration this same pass parsed, and is exactly the
     * trap that has already cost two other call sites (edge targets, then Spring
     * Data {@code queries}).
     */
    private static void collectSelectors(
            ParsedFile file,
            Map<String, String> keyIndex,
            java.util.Set<String> primaryKeys,
            java.util.Set<String> qualifiedKeys) {
        for (var type :
                file.cu().findAll(com.github.javaparser.ast.body.ClassOrInterfaceDeclaration.class)) {
            boolean primary = SpringAnnotations.has(type, SpringAnnotations.PRIMARY);
            boolean qualified = SpringAnnotations.has(type, SpringAnnotations.QUALIFIER);
            if (!primary && !qualified) {
                continue;
            }
            for (var method : type.getMethods()) {
                String key = Declarations.keyOfIndexed(method, keyIndex, file.anonymousNames());
                if (primary) {
                    primaryKeys.add(key);
                }
                if (qualified) {
                    qualifiedKeys.add(key);
                }
            }
        }
    }

    /** One parsed file, retained between the two passes. */
    private record ParsedFile(
            CompilationUnit cu, String relativePath, Map<ObjectCreationExpr, String> anonymousNames) {}

    private JavaParser configuredParser() {
        ParserConfiguration config =
                new ParserConfiguration()
                        .setLanguageLevel(LANGUAGE_LEVEL)
                        .setSymbolResolver(new JavaSymbolSolver(typeSolver));
        return new JavaParser(config);
    }

    private static String firstProblem(List<Problem> problems) {
        return problems.isEmpty() ? "unparseable" : problems.getFirst().getMessage();
    }
}

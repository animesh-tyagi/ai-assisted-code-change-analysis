package com.impact.parser.resolve;

import com.github.javaparser.resolution.TypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import com.impact.parser.workspace.WorkspaceLayout;

/**
 * v1 resolution: the analysed repository's own source plus the JDK, and nothing
 * else (DECISIONS D2).
 *
 * <p>This covers the impact surface completely, because that surface is made of
 * intra-repo edges. Spring's implicit edges are matched by annotation name off
 * the raw AST, so Spring's own types never need to be resolvable. What does not
 * resolve is calls into third-party libraries — recorded as {@code unresolved:}
 * edges (section 6.5), never dropped.
 *
 * <p>A solver is built over every <em>solver</em> root, which is a superset of the
 * extraction roots: generated sources resolve without becoming nodes. It also
 * spans the whole workspace even when only a few files are extracted, which is
 * load-bearing for subset mode (D4) — a call from a touched file into an
 * untouched one still resolves; only the extraction is narrowed.
 */
public final class SourceAndJdkTypeSolverFactory implements TypeSolverFactory {

    @Override
    public TypeSolver create(WorkspaceLayout layout) {
        CombinedTypeSolver combined = new CombinedTypeSolver();

        // JRE_ONLY, stated explicitly rather than relying on the no-arg default.
        //
        // This is a correctness boundary, not a preference. ReflectionTypeSolver
        // resolves through *this service's own* class loader, and this service is
        // a Spring Boot app with ~19 Spring jars on its classpath. Constructed
        // with ALL_CLASSES it would happily resolve the analysed repository's
        // `org.springframework.*` calls — using our dependency versions, not
        // theirs. Output would then depend on the parser's own classpath, which
        // breaks the section 8 guarantee that a response is a pure function of
        // (workspace, mode, files, options), and would silently change the graph
        // whenever we bumped a dependency.
        //
        // Pinned by ReflectionTypeSolverScopeTest.
        combined.add(new ReflectionTypeSolver(true));

        for (var sourceRoot : layout.solverRoots()) {
            combined.add(new JavaParserTypeSolver(sourceRoot));
        }
        return combined;
    }

    @Override
    public String describe() {
        return "source+jdk";
    }
}

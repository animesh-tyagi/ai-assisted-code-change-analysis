package com.impact.parser.resolve;

import com.github.javaparser.resolution.TypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.CombinedTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.JavaParserTypeSolver;
import com.github.javaparser.symbolsolver.resolution.typesolvers.ReflectionTypeSolver;
import com.impact.parser.workspace.WorkspaceLayout;

/**
 * v1 resolution: the repository's own source plus the JDK, and nothing else
 * (DECISIONS D2).
 *
 * <p>This covers the impact surface completely, because that surface is made of
 * intra-repo edges. Spring's implicit edges are matched by annotation name off
 * the raw AST, so Spring's own types never need to be resolvable. What does not
 * resolve is calls into third-party libraries — recorded as {@code unresolved:}
 * edges (section 6.5), never dropped.
 *
 * <p>A solver is built over <em>every</em> source root even when only a few files
 * are being extracted. That is deliberate and load-bearing for subset mode (D4):
 * the whole worktree is on disk, so a call from a touched file into an untouched
 * one still resolves; only the extraction is narrowed.
 */
public final class SourceAndJdkTypeSolverFactory implements TypeSolverFactory {

    @Override
    public TypeSolver create(WorkspaceLayout layout) {
        CombinedTypeSolver combined = new CombinedTypeSolver();
        // The JDK first: it is the cheapest to consult and the most frequently hit.
        combined.add(new ReflectionTypeSolver());
        for (var sourceRoot : layout.sourceRoots()) {
            combined.add(new JavaParserTypeSolver(sourceRoot));
        }
        return combined;
    }

    @Override
    public String describe() {
        return "source+jdk";
    }
}

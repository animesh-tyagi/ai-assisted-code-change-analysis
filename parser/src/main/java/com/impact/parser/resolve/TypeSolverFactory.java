package com.impact.parser.resolve;

import com.github.javaparser.resolution.TypeSolver;
import com.impact.parser.workspace.WorkspaceLayout;

/**
 * The upgrade seam promised by DECISIONS D2.
 *
 * <p>v1 resolves against source + the JDK only: no Maven or Gradle is invoked, so
 * indexing stays seconds rather than minutes. The cost is that types from
 * third-party jars do not resolve, which section 6.5 absorbs by recording those
 * call sites as {@code unresolved:} edges rather than dropping them.
 *
 * <p>The eventual upgrade — resolving the dependency classpath and adding a
 * {@code JarTypeSolver} per jar, cached per {@code pom.xml}/{@code build.gradle}
 * hash — arrives as a second implementation of this interface. Keeping it behind
 * this boundary is what lets that land without touching the graph model or node
 * keys. The trigger is {@code unresolvedRate} staying high enough to degrade
 * explanations.
 */
public interface TypeSolverFactory {

    /** Builds a solver covering the whole workspace. */
    TypeSolver create(WorkspaceLayout layout);

    /**
     * Short description of the resolution strategy, reported in diagnostics.
     *
     * <p>Recorded so that a graph built with weaker resolution is identifiable
     * after the fact rather than silently indistinguishable from a stronger one.
     */
    String describe();
}

package com.impact.parser.graph;

import java.util.List;

/**
 * One method or constructor node, matching the {@code functions[]} entry of the
 * parse response (ARCHITECTURE.md section 8).
 *
 * @param key the node key of section 6.1 — see {@link NodeKeys}
 * @param paramTypes erased, fully-qualified parameter types; part of {@code key}
 * @param paramNames parameter names as written. Deliberately <em>not</em> part of
 *     identity: renaming a parameter is the same node with a new version.
 * @param returnType erased return type, or the type as written when it could not
 *     be resolved
 * @param filePath workspace-relative, always with forward slashes so output does
 *     not differ between Windows and Linux
 * @param startLine first line of the declaration, annotations included, so the
 *     range is usable directly by {@code git log -L} (C7)
 * @param bodyHash {@code sha256:...} over the pretty-printed body, so a pure
 *     reformat does not read as a change. Absent bodies (abstract and interface
 *     methods) hash the empty string.
 * @param unresolvedParamTypes count of parameters whose type could not be
 *     resolved and fell back to import-based qualification; feeds diagnostics
 */
public record ParsedFunction(
        String key,
        String fqcn,
        String className,
        String methodName,
        List<String> paramTypes,
        List<String> paramNames,
        String returnType,
        String filePath,
        int startLine,
        int endLine,
        String bodyHash,
        List<String> modifiers,
        List<AnnotationRef> annotations,
        boolean isAbstract,
        boolean isInterfaceMethod,
        int unresolvedParamTypes) {

    public boolean hasAnnotation(String name) {
        return annotations.stream().anyMatch(a -> a.isNamed(name));
    }
}

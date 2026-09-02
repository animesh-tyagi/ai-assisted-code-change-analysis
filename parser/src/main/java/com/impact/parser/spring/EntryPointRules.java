package com.impact.parser.spring;

import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.expr.AnnotationExpr;
import com.impact.parser.graph.CallSite;
import com.impact.parser.graph.Confidence;
import com.impact.parser.graph.EdgeCollector;
import com.impact.parser.graph.EdgeType;
import com.impact.parser.graph.SurfaceCollector;
import com.impact.parser.graph.SurfaceKind;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * Entry points: the places something outside the codebase reaches in
 * (ARCHITECTURE.md §6.4).
 *
 * <p>These are why the product answers "what breaks" at all. A controller method
 * has no in-repo caller — Spring invokes it — so without a route surface it looks
 * dead, and a change to it would appear to affect nobody. The surface is the
 * terminal that reverse traversal collapses to (§10, Zone 2).
 *
 * <p>Edges point <em>from</em> the surface <em>to</em> the method: the route
 * depends on the handler, so reverse traversal from a changed method finds the
 * route by matching {@code to}.
 */
public final class EntryPointRules {

    private final EdgeCollector edges;
    private final SurfaceCollector surfaces;

    public EntryPointRules(EdgeCollector edges, SurfaceCollector surfaces) {
        this.edges = edges;
        this.surfaces = surfaces;
    }

    /**
     * @param keyOf names a method the same way {@code functions[]} did — passed in
     *     rather than recomputed, so a surface can never point at a key that no
     *     node carries
     */
    public void apply(
            CompilationUnit cu,
            String relativePath,
            Function<MethodDeclaration, String> keyOf) {
        for (ClassOrInterfaceDeclaration type : cu.findAll(ClassOrInterfaceDeclaration.class)) {
            String classPath = classLevelPath(type);
            for (MethodDeclaration method : type.getMethods()) {
                String methodKey = keyOf.apply(method);
                CallSite site = new CallSite(relativePath, method.getBegin().map(p -> p.line).orElse(0));
                httpRoute(method, classPath, methodKey, site);
                scheduledJob(method, methodKey, site);
                messageListener(method, methodKey, site);
            }
        }
    }

    // -----------------------------------------------------------------------
    // HTTP routes
    // -----------------------------------------------------------------------

    private static String classLevelPath(ClassOrInterfaceDeclaration type) {
        return SpringAnnotations.find(type, SpringAnnotations.REQUEST_MAPPING)
                .flatMap(SpringAnnotations::firstValue)
                .orElse("");
    }

    private void httpRoute(MethodDeclaration method, String classPath, String methodKey, CallSite site) {
        for (var entry : SpringAnnotations.HTTP_MAPPINGS.entrySet()) {
            Optional<AnnotationExpr> mapping = SpringAnnotations.find(method, entry.getKey());
            if (mapping.isPresent()) {
                emitRoute(entry.getValue(), classPath, mapping.get(), methodKey, site);
                return;
            }
        }
        // @RequestMapping on a method carries its verb in `method = RequestMethod.GET`.
        SpringAnnotations.find(method, SpringAnnotations.REQUEST_MAPPING)
                .ifPresent(
                        annotation ->
                                emitRoute(
                                        verbOf(annotation), classPath, annotation, methodKey, site));
    }

    /**
     * The HTTP verb of a method-level {@code @RequestMapping}.
     *
     * <p>Absent a {@code method =} member, Spring maps every verb. Rather than
     * invent one, the route records {@code ANY} — honest about what the annotation
     * actually says.
     */
    private static String verbOf(AnnotationExpr annotation) {
        String declared = SpringAnnotations.members(annotation).get("method");
        if (declared == null) {
            return "ANY";
        }
        // RequestMethod.GET / {RequestMethod.GET} / GET all reduce to the last name.
        String cleaned = declared.replaceAll("[{}]", "").trim();
        String first = cleaned.split(",")[0].trim();
        int lastDot = first.lastIndexOf('.');
        return (lastDot == -1 ? first : first.substring(lastDot + 1)).toUpperCase();
    }

    private void emitRoute(
            String verb, String classPath, AnnotationExpr mapping, String methodKey, CallSite site) {
        String methodPath = SpringAnnotations.firstValue(mapping).orElse("");
        String path = SpringAnnotations.joinPaths(classPath, methodPath);
        String key = "route:" + verb + " " + path;

        Map<String, String> attrs = new LinkedHashMap<>();
        attrs.put("httpMethod", verb);
        attrs.put("path", path);
        surfaces.add(key, SurfaceKind.HTTP_ROUTE, attrs);

        // An unresolved ${property} placeholder is kept verbatim rather than
        // guessed at, and the edge says so (§6.4).
        Confidence confidence = path.contains("${") ? Confidence.AMBIGUOUS : Confidence.EXACT;
        edges.add(key, methodKey, EdgeType.HANDLES, true, confidence, site);
    }

    // -----------------------------------------------------------------------
    // Scheduled jobs and listeners
    // -----------------------------------------------------------------------

    private void scheduledJob(MethodDeclaration method, String methodKey, CallSite site) {
        SpringAnnotations.find(method, SpringAnnotations.SCHEDULED)
                .ifPresent(
                        annotation -> {
                            String key = "job:" + methodKey.substring("fn:".length());
                            Map<String, String> members = SpringAnnotations.members(annotation);
                            Map<String, String> attrs = new LinkedHashMap<>();
                            // cron, fixedRate and fixedDelay are alternatives; keep
                            // whichever was written rather than normalising to one.
                            members.forEach(attrs::put);
                            surfaces.add(key, SurfaceKind.SCHEDULED_JOB, attrs);
                            edges.add(key, methodKey, EdgeType.TRIGGERS, true, Confidence.EXACT, site);
                        });
    }

    private void messageListener(MethodDeclaration method, String methodKey, CallSite site) {
        for (var entry : SpringAnnotations.LISTENERS.entrySet()) {
            SpringAnnotations.find(method, entry.getKey())
                    .ifPresent(
                            annotation -> {
                                Map<String, String> members = SpringAnnotations.members(annotation);
                                String topic =
                                        members.getOrDefault(
                                                "topics",
                                                members.getOrDefault(
                                                        "queues",
                                                        members.getOrDefault(
                                                                "destination",
                                                                members.getOrDefault("value", ""))));
                                String cleanedTopic = topic.replaceAll("[{}\"]", "").trim();
                                String key =
                                        "listener:"
                                                + entry.getValue()
                                                + ":"
                                                + (cleanedTopic.isEmpty()
                                                        ? methodKey.substring("fn:".length())
                                                        : cleanedTopic);
                                Map<String, String> attrs = new LinkedHashMap<>();
                                attrs.put("broker", entry.getValue());
                                if (!cleanedTopic.isEmpty()) {
                                    attrs.put("topic", cleanedTopic);
                                }
                                surfaces.add(key, SurfaceKind.MESSAGE_LISTENER, attrs);
                                edges.add(
                                        key, methodKey, EdgeType.TRIGGERS, true, Confidence.EXACT, site);
                            });
        }
    }
}

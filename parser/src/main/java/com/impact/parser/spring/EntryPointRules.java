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
                httpRoute(type, method, classPath, methodKey, site);
                scheduledJob(type, method, methodKey, site);
                messageListener(type, method, methodKey, site);
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

    private void httpRoute(
            ClassOrInterfaceDeclaration type,
            MethodDeclaration method,
            String classPath,
            String methodKey,
            CallSite site) {
        // A mapping on an interface method is a declaration to be inherited, not a
        // route in its own right: Spring serves a route only through a concrete
        // request-handling bean. Emitting one here would represent a single
        // endpoint as two surfaces — once unprefixed on the interface, once
        // properly prefixed on the controller — and inflate the entry-point count
        // that reverse traversal reports.
        if (type.isInterface()) {
            return;
        }
        if (emitFrom(method, classPath, methodKey, site, false)) {
            return;
        }
        // Inherited mapping. A controller may declare no mapping of its own and
        // implement an interface that carries it — the OpenAPI-generated API
        // interfaces petclinic uses put every method-level @RequestMapping there,
        // under target/generated-sources. Spring still serves those routes against
        // this controller method, so the route is real; only its declaration site
        // is generated. Reading it needs no node for the generated interface.
        for (MethodDeclaration inherited : Supertypes.correspondingMethods(type, method)) {
            if (emitFrom(inherited, classPath, methodKey, site, true)) {
                return;
            }
        }
    }

    /**
     * Emits a route from whichever declaration carries the mapping.
     *
     * <p>The path always concatenates <em>this controller's</em> class-level
     * mapping with the method-level one, even when the latter was inherited: the
     * class-level prefix belongs to the implementing controller, not to the
     * interface.
     */
    private boolean emitFrom(
            MethodDeclaration declaration,
            String classPath,
            String methodKey,
            CallSite site,
            boolean inherited) {
        for (var entry : SpringAnnotations.HTTP_MAPPINGS.entrySet()) {
            Optional<AnnotationExpr> mapping = SpringAnnotations.find(declaration, entry.getKey());
            if (mapping.isPresent()) {
                emitRoute(
                        entry.getValue(), classPath, mapping.get(), declaration, methodKey, site, inherited);
                return true;
            }
        }
        // @RequestMapping on a method carries its verb in `method = RequestMethod.GET`.
        Optional<AnnotationExpr> requestMapping =
                SpringAnnotations.find(declaration, SpringAnnotations.REQUEST_MAPPING);
        if (requestMapping.isPresent()) {
            emitRoute(
                    verbOf(requestMapping.get()),
                    classPath,
                    requestMapping.get(),
                    declaration,
                    methodKey,
                    site,
                    inherited);
            return true;
        }
        return false;
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
            String verb,
            String classPath,
            AnnotationExpr mapping,
            MethodDeclaration declaringMember,
            String methodKey,
            CallSite site,
            boolean inherited) {
        SpringAnnotations.PathValue methodPath =
                SpringAnnotations.resolveConstants(
                        declaringMember, SpringAnnotations.firstValue(mapping).orElse(""));
        String path = SpringAnnotations.joinPaths(classPath, methodPath.value());
        String key = "route:" + verb + " " + path;

        Map<String, String> attrs = new LinkedHashMap<>();
        attrs.put("httpMethod", verb);
        attrs.put("path", path);
        surfaces.add(key, SurfaceKind.HTTP_ROUTE, attrs);

        // An unresolved ${property} placeholder is kept verbatim rather than
        // guessed at, and the edge says so (§6.4).
        // inferred:true either way — Spring wires the route, it is not a written
        // call. Inheriting the mapping does not lower confidence: the annotation
        // was read from a real declaration, not guessed at. Only an unresolved
        // ${property} placeholder does.
        boolean uncertain = path.contains("${") || !methodPath.exact();
        Confidence confidence = uncertain ? Confidence.AMBIGUOUS : Confidence.EXACT;
        edges.add(key, methodKey, EdgeType.HANDLES, true, confidence, site);
    }

    // -----------------------------------------------------------------------
    // Scheduled jobs and listeners
    // -----------------------------------------------------------------------

    /**
     * Finds an annotation on the method that will actually run it, not on an
     * abstract declaration that never does.
     *
     * <p>Mirrors {@link #httpRoute}'s interface handling, generalized: an
     * interface method can never itself be scheduled or invoked as a listener
     * (there is no bean to run it), so a direct annotation there is not a real
     * entry point — and a concrete override that leaves the annotation on the
     * interface and doesn't repeat it is still a real one, found by walking
     * {@link Supertypes#correspondingMethods}. Before this, {@code
     * scheduledJob}/{@code messageListener} read only the method's own
     * annotations, which cut both ways: an interface-declared {@code @Scheduled}
     * produced a surface for a method that can never run, while a concrete
     * override relying on an inherited annotation produced none at all.
     */
    private static Optional<AnnotationExpr> declaredAnnotation(
            ClassOrInterfaceDeclaration type, MethodDeclaration method, String annotationName) {
        if (type.isInterface()) {
            return Optional.empty();
        }
        Optional<AnnotationExpr> direct = SpringAnnotations.find(method, annotationName);
        if (direct.isPresent()) {
            return direct;
        }
        for (MethodDeclaration inherited : Supertypes.correspondingMethods(type, method)) {
            Optional<AnnotationExpr> found = SpringAnnotations.find(inherited, annotationName);
            if (found.isPresent()) {
                return found;
            }
        }
        return Optional.empty();
    }

    private void scheduledJob(
            ClassOrInterfaceDeclaration type, MethodDeclaration method, String methodKey, CallSite site) {
        declaredAnnotation(type, method, SpringAnnotations.SCHEDULED)
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

    private void messageListener(
            ClassOrInterfaceDeclaration type, MethodDeclaration method, String methodKey, CallSite site) {
        for (var entry : SpringAnnotations.LISTENERS.entrySet()) {
            declaredAnnotation(type, method, entry.getKey())
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

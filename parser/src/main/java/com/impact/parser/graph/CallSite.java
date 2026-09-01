package com.impact.parser.graph;

/** Where in the source an edge was observed. */
public record CallSite(String filePath, int line) implements Comparable<CallSite> {

    @Override
    public int compareTo(CallSite other) {
        int byPath = filePath.compareTo(other.filePath);
        return byPath != 0 ? byPath : Integer.compare(line, other.line);
    }
}

import path from "node:path";

export function defaultName(cwd: string): string {
    const raw = path.basename(cwd);
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug === "" ? "relay" : slug;
}

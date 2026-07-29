// packages/render/table/utils/tableSerialization.ts

import { TableMeta } from "../../table/types";
import { fetchAndCacheTableRows } from "../fetchAndCacheTableRows";

/**
 * Fetches all rows for a given table from the database and serializes the metadata 
 * and rows into a structured Markdown format.
 */
export const fetchAndSerializeTable = async (
    tableMeta: TableMeta,
    db: any,
    options: {
        token?: string | null;
        remoteServers?: string[];
    } = {}
): Promise<{ rows: any[]; markdown: string }> => {
    const tenantId = tableMeta.tenantId;
    const tableId = tableMeta.tableId;
    const results = await fetchAndCacheTableRows({
        db,
        tenantId,
        tableId,
        token: options.token,
        remoteServers: options.remoteServers ?? [],
    });

    // Format as Markdown table
    const columns = tableMeta.columns || [];
    const headerRow = columns.map((c) => c.label || c.name);
    const separatorRow = columns.map(() => "---");

    let tableMd = "";
    if (columns.length > 0) {
        tableMd = `| ${headerRow.join(" | ")} |\n| ${separatorRow.join(" | ")} |\n`;
        results.forEach((row: any) => {
            const rowData = columns.map((col) => {
                const val = row[col.name];
                return val === undefined || val === null
                    ? ""
                    : String(val).replace(/\|/g, "\\|");
            });
            tableMd += `| ${rowData.join(" | ")} |\n`;
        });
    } else {
        tableMd = "(No columns defined for this table)";
    }

    return { rows: results, markdown: tableMd };
};

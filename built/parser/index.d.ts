import { Node, node_d_exports } from "../node.js";
//#region src/parser/index.d.ts
export type ParserPlugin = (nodes: Node[]) => Node[];
export type PluginType = 'validate' | 'transform';
export declare class Parser {
  private static instance?;
  private plugins;
  constructor();
  static parse(input: string): Node[];
  addPlugin(type: PluginType, plugin: ParserPlugin): void;
  parse(input: string): Node[];
}
//#endregion
//# sourceMappingURL=index.d.ts.map
//#region src/v2/catalog.d.ts
export type CatalogArgument = {
  name: string;
  type: string;
  optional?: boolean;
  rest?: boolean;
};
export type CatalogFunction = {
  name: string;
  receiver: 'global' | 'array' | 'string' | 'number' | 'iterator';
  args: readonly CatalogArgument[];
  returns: string;
  description: {
    ja: string;
    en: string;
  };
};
export type CatalogConstant = Omit<CatalogFunction, 'receiver'> & {
  receiver: 'global';
  kind: 'constant';
};
export type CatalogEntry = CatalogFunction | CatalogConstant;
//#endregion
//# sourceMappingURL=catalog.d.ts.map
/**
 * The policy language: what a `samesight.policy.ts` file is written in.
 *
 * Everything here builds plain data. The compiler (ir.ts) validates it against the
 * database schema and both emitters read the result, so RLS and sync streams always
 * come from the same tree.
 *
 * Typing: `definePolicy<Database>` takes the type from `supabase gen types`, so table
 * names, and the column names inside each `table({...})`, are checked by the editor.
 */

// Values and conditions --------------------------------------------------------------

/** The signed-in user: `(select auth.uid())` in RLS, `auth.user_id()` in streams. */
export interface UserClaim {
  readonly kind: "user";
}

export type Literal = string | number | boolean;
export type Value = Literal | UserClaim;

/** Rows of another table, for write checks only (streams cannot express it). */
export interface RowsOf {
  readonly kind: "rows";
  readonly table: string;
  readonly column: string;
  readonly where?: Condition;
}

/**
 * A row condition. `C` is the set of column names it mentions; it only exists for type
 * checking (a condition naming a column the table lacks fails to compile). Annotate
 * helpers as `Condition<"col">` or leave the return type out: a bare `Condition` means
 * "any column" and will not fit a typed table.
 */
export type Condition<C extends string = string> = ConditionNode & { readonly __columns?: C };

export type ConditionNode =
  | { readonly kind: "eq"; readonly column: string; readonly value: Value }
  | { readonly kind: "in"; readonly column: string; readonly values: readonly Literal[] }
  | { readonly kind: "inRows"; readonly column: string; readonly rows: RowsOf }
  | { readonly kind: "isNull"; readonly column: string; readonly negate: boolean }
  | { readonly kind: "via"; readonly column: string; readonly parent: string; readonly parentKey: string }
  | { readonly kind: "and"; readonly items: readonly ConditionNode[] }
  | { readonly kind: "or"; readonly items: readonly ConditionNode[] }
  | { readonly kind: "raw"; readonly rls: string; readonly sync: string };

export interface ColumnRef<C extends string> {
  /** Equal to a literal or to `claim.user`. */
  eq(value: Value): Condition<C>;
  /** One of a fixed list (`IN (...)` in RLS, an OR chain in streams), or rows of another table (writes only). */
  in(values: readonly Literal[] | RowsOf): Condition<C>;
  isNull(): Condition<C>;
  isNotNull(): Condition<C>;
}

/** A column of the table the rule belongs to. */
export function col<C extends string>(column: C): ColumnRef<C> {
  return {
    eq: (value) => ({ kind: "eq", column, value }),
    in: (values) =>
      isRowsOf(values)
        ? { kind: "inRows", column, rows: values }
        : { kind: "in", column, values: [...(values as readonly Literal[])] },
    isNull: () => ({ kind: "isNull", column, negate: false }),
    isNotNull: () => ({ kind: "isNull", column, negate: true }),
  };
}

function isRowsOf(v: unknown): v is RowsOf {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "rows";
}

/** Visible when the parent row it points at is visible to the same user. */
export function via<C extends string>(column: C, parent: string, options: { key?: string } = {}): Condition<C> {
  return { kind: "via", column, parent, parentKey: options.key ?? "id" };
}

/** `column` values of `table`'s rows (that the caller can read) matching `where`. Write checks only. */
export function rowsOf(table: string, column: string, where?: Condition): RowsOf {
  return { kind: "rows", table, column, where };
}

export function and<C extends string>(...items: Condition<C>[]): Condition<C> {
  return { kind: "and", items };
}

export function or<C extends string>(...items: Condition<C>[]): Condition<C> {
  return { kind: "or", items };
}

/**
 * Hand-written SQL for both sides, for what the language cannot say. The verifier
 * covers raw rules like any other, and its report lists each one for review.
 */
export function raw(sides: { rls: string; sync: string }): Condition<never> {
  return { kind: "raw", rls: sides.rls, sync: sides.sync };
}

// Claims ---------------------------------------------------------------------------------

export interface UuidClaim {
  readonly kind: "uuid";
  readonly name: string;
}

export interface RoleClaim<R extends string = string> {
  readonly kind: "oneOf";
  readonly name: string;
  readonly values: readonly R[];
}

export const claim = {
  /** The signed-in user, for use in conditions. */
  user: { kind: "user" } as UserClaim,
  /** A uuid claim in the token, e.g. `claim.uuid("tenant_id")`. */
  uuid: (name: string): UuidClaim => ({ kind: "uuid", name }),
  /** A claim holding one of a fixed set of values, e.g. the app role. */
  oneOf: <const R extends string>(name: string, values: readonly R[]): RoleClaim<R> => ({
    kind: "oneOf",
    name,
    values,
  }),
};

// Tables ---------------------------------------------------------------------------------

/** Per role (or `"*"` for every role): `true`, or a condition on the row. */
export type RoleRules<C extends string> = { readonly [role: string]: true | Condition<C> };

export interface TableSpec<C extends string = string> {
  /**
   * The column holding the row's tenant (`"id"` for the tenant table itself), or `null`
   * for reference data every tenant shares (plans, countries, categories). A shared table
   * is read-only to clients: its rows come from migrations or the service role.
   */
  tenant: C | null;
  /** Who reads which rows. Compiles to RLS and to sync streams. */
  read?: RoleRules<C>;
  /** Shorthand for the same rule on insert, update and delete; ORed with any rule they also have. */
  write?: RoleRules<C>;
  insert?: RoleRules<C>;
  /** Applies to the row before (USING) and after (WITH CHECK) the update. */
  update?: RoleRules<C>;
  delete?: RoleRules<C>;
  /** Must hold for every inserted or updated row, whatever the role (WITH CHECK only). */
  check?: Condition<C>;
  /** Columns left out of a role's sync projection. RLS cannot hide columns; see the docs. */
  hide?: { readonly [role: string]: readonly C[] };
  /** Columns the server sets; dropped from client writes. */
  serverOwned?: readonly C[];
  /** Columns a client may set on insert but never change. */
  immutable?: readonly C[];
  /** Set to the signed-in user by the column default; inserts must carry exactly that. */
  author?: C;
  /** Set to now() by a trigger on every update. */
  touch?: C;
  /** Rows are never updated or deleted; corrections are new rows. */
  appendOnly?: { supersedes?: C; order?: C };
}

/** Identity function that gives the editor the table's column names. */
export function table<C extends string>(spec: TableSpec<C>): TableSpec<C> {
  return spec;
}

// The policy -----------------------------------------------------------------------------

type PublicTables<DB> = DB extends { public: { Tables: infer T } } ? T : Record<string, { Row: Record<string, unknown> }>;
type TableName<DB> = Extract<keyof PublicTables<DB>, string>;
type ColumnOf<DB, T> = T extends keyof PublicTables<DB>
  ? PublicTables<DB>[T] extends { Row: infer Row }
    ? Extract<keyof Row, string>
    : string
  : string;

export interface OutputPaths {
  /** Directory of Supabase migrations. */
  migrations?: string;
  syncConfig?: string;
  serviceConfig?: string;
  clientSchema?: string;
  policyTypes?: string;
  manifest?: string;
  /** The introspected schema `generate` read; `check` compares against it without a database. */
  schemaSnapshot?: string;
}

type MembershipSpec<DB> = {
  [T in TableName<DB>]: { table: T; user: ColumnOf<DB, T>; tenant: ColumnOf<DB, T>; role: ColumnOf<DB, T> };
}[TableName<DB>];

export interface PolicySpec<DB = unknown> {
  auth: "supabase";
  claims: { tenant: UuidClaim; role: RoleClaim };
  /** Where the access token hook reads tenant and role for a signing-in user. */
  membership: MembershipSpec<DB>;
  tables: { [T in TableName<DB>]?: TableSpec<ColumnOf<DB, T>> };
  /** Roles that read the server copy of refused writes for their tenant. Default: none. */
  rejectedWrites?: { read: readonly string[] };
  output?: OutputPaths;
  client?: {
    /** Package the generated client schema imports `column`, `Schema` and `Table` from. */
    import?: string;
  };
}

export interface Policy {
  readonly kind: "samesight-policy";
  readonly spec: PolicySpec;
}

export function definePolicy<DB = unknown>(spec: PolicySpec<DB>): Policy {
  return { kind: "samesight-policy", spec: spec as unknown as PolicySpec };
}

export function isPolicy(value: unknown): value is Policy {
  if (typeof value !== "object" || value === null || (value as Policy).kind !== "samesight-policy") return false;
  const spec = (value as Policy).spec as Partial<Policy["spec"]> | undefined;
  return typeof spec === "object" && spec !== null && typeof spec.tables === "object" && typeof spec.membership === "object";
}

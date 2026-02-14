/** Remove SQL bracket delimiters from a name: [dbo].[Table] → dbo.Table */
export function stripBrackets(name: string): string {
  return name.replace(/\[|\]/g, '');
}

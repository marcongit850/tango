/** Example owner roster. Headers match the import page. Two rows, not a full neighborhood. */
export const OWNER_IMPORT_TEMPLATE = `email,name,lot_number,street_address,role,admin,starting_balance,balance_as_of,phone,city,state,postal_code,house_name,mailing_street,mailing_city,mailing_state,mailing_postal_code,owner2_name,owner2_email,owner2_phone
casey.nguyen@example.com,Casey Nguyen,27,"Lot 27, Tang O Mar Drive",homeowner,,375.50,2026-01-15,850-555-0142,Miramar Beach,FL,32550,MELOMAR,"100 Main Street",Destin,FL,32541,Alex Kim,alex.kim@example.com,850-555-0199
jordan.lee@example.com,Jordan Lee,3,"Lot 3, Tang O Mar Drive",board,yes,0,,850-555-0101,Miramar Beach,FL,32550,AVERITTS FAVORITE,,,,,,,
`;

const SAMPLE_OWNER_IMPORT_TEMPLATE = `email,name,lot_number,street_address,role,admin,starting_balance,balance_as_of,phone,city,state,postal_code,house_name,mailing_street,mailing_city,mailing_state,mailing_postal_code,owner2_name,owner2_email,owner2_phone
pat.sample@example.com,Pat Sample,12,"12 Dune Lane",homeowner,,375.50,2026-01-15,850-555-2101,Sample Harbor,FL,33021,Coast Cottage,"500 Inland Road",Sample Harbor,FL,33021,Alex Sample,alex.sample@example.com,850-555-2199
quinn.sample@example.com,Quinn Sample,4,"4 Dune Lane",board,yes,0,,850-555-2102,Sample Harbor,FL,33021,Harbor House,,,,,,,
`;

/** Tang-O-Mar keeps its own example file. Every other neighborhood gets a neutral sample. */
export function ownerImportTemplateFor(association: { slug: string }): string {
  if (association.slug === "tango-mar") return OWNER_IMPORT_TEMPLATE;
  return SAMPLE_OWNER_IMPORT_TEMPLATE;
}

// Standalone extraction of build_thru_registrar_purchase_domain_instruction
// from the official Thru CLI v0.2.39/v0.2.40 txn_tools.rs. Both extracted
// versions are byte-identical. This dependency-free harness emits the golden
// fixture consumed by tests/name-purchase.test.ts.

fn build_purchase_instruction(
    indexes: [u16; 9],
    domain_name: &str,
    years: u8,
    lease_proof: &[u8],
    domain_proof: &[u8],
) -> Vec<u8> {
    let mut instruction_data = Vec::new();
    instruction_data.extend_from_slice(&1u32.to_le_bytes());
    for index in indexes {
        instruction_data.extend_from_slice(&index.to_le_bytes());
    }

    let domain_bytes = domain_name.as_bytes();
    assert!(domain_bytes.len() <= 64);
    let mut domain_padded = [0u8; 64];
    domain_padded[..domain_bytes.len()].copy_from_slice(domain_bytes);
    instruction_data.extend_from_slice(&domain_padded);
    instruction_data.extend_from_slice(&(domain_bytes.len() as u32).to_le_bytes());
    instruction_data.push(years);
    instruction_data.extend_from_slice(lease_proof);
    instruction_data.extend_from_slice(domain_proof);
    instruction_data
}

fn main() {
    let bytes = build_purchase_instruction(
        [2, 3, 4, 8, 7, 5, 6, 9, 10],
        "A",
        3,
        &[0xaa, 0xbb],
        &[0xcc, 0xdd, 0xee, 0xff],
    );
    for byte in bytes {
        print!("{byte:02x}");
    }
    println!();
}

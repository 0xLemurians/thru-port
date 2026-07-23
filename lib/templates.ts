/**
 * Hazır C proje şablonları.
 *
 * Bu kaynaklar daha önce RISC-V toolchain (v0.2.38) ve Thru C SDK
 * (v0.2.38) ile manuel olarak derlendi:
 *   -std=c17 -Werror -Wall -Wextra -Wpedantic -Wstrict-aliasing=2 -Wconversion
 * altında .bin dosyası üretildi. Bu repoda henüz otomatik toolchain testi
 * bulunmadığı için UI bu manuel doğrulamayı sürekli bir garanti gibi sunmaz.
 * "Blank" şablonu
 * Unto-Labs/thru reposundaki resmi CLI şablonunun (templates/c/program.c)
 * birebir kopyasıdır.
 *
 * Not: derleme doğrulaması bu programların SÖZDİZİMSEL/SDK-API açısından
 * doğru olduğunu kanıtlar. Zincirde çalıştırıldıklarında beklenen state
 * hesap düzenini kullanıp kullanmadıkları (örn. "kendi programının hesabı"
 * mantığı) ancak gerçek bir deploy+invoke ile (Aşama 7) doğrulanabilir —
 * bu henüz yapılmadı.
 */

export interface ThruTemplate {
  id: string;
  name: string;
  description: string;
  fileName: string;
  accountDataBytes: number;
  instructionFormat: string;
  source: string;
}

const BLANK_SOURCE = `/* MyProgram - Thru Program
 * A simple hello world program for the Thru blockchain
 */

#include <thru-sdk/c/tn_sdk.h>

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data    TSDK_PARAM_UNUSED,
       ulong        instruction_data_sz TSDK_PARAM_UNUSED ) {
  tsdk_return( 0UL );
}
`;

const COUNTER_SOURCE = `/* Counter - Thru Program
 * Stores a single counter in this program's own account data and
 * increments it by 1 on every invocation.
 */

#include <thru-sdk/c/tn_sdk.h>

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data    TSDK_PARAM_UNUSED,
       ulong        instruction_data_sz TSDK_PARAM_UNUSED ) {
  ushort const acc_idx = tsdk_get_current_program_acc_idx();

  TSDK_ASSERT_OR_REVERT( tsdk_account_exists( acc_idx ), 1UL );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( acc_idx );
  TSDK_ASSERT_OR_REVERT( meta->data_sz >= sizeof(ulong), 2UL );

  void * data = tsdk_get_account_data_ptr( acc_idx );

  ulong count = TSDK_LOAD( ulong, data );
  TSDK_ASSERT_OR_REVERT( count != ~0UL, 3UL );
  count += 1UL;
  TSDK_STORE( ulong, data, count );

  tsdk_printf( "counter: %lu\\n", count );

  tsdk_return( 0UL );
}
`;

const MESSAGE_STORAGE_SOURCE = `/* Message Storage - Thru Program
 * Overwrites this program's account data with the message passed in
 * instruction_data. Layout: [8 bytes LE length][message bytes].
 */

#include <thru-sdk/c/tn_sdk.h>

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  ushort const acc_idx = tsdk_get_current_program_acc_idx();

  TSDK_ASSERT_OR_REVERT( tsdk_account_exists( acc_idx ), 1UL );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( acc_idx );
  ulong const capacity = (ulong)meta->data_sz;

  TSDK_ASSERT_OR_REVERT( capacity >= sizeof(ulong), 2UL );
  TSDK_ASSERT_OR_REVERT( instruction_data_sz <= capacity - sizeof(ulong), 3UL );

  void * data = tsdk_get_account_data_ptr( acc_idx );

  TSDK_STORE( ulong, data, instruction_data_sz );
  memcpy( (uchar *)data + sizeof(ulong), instruction_data, instruction_data_sz );

  tsdk_printf( "message stored: %lu bytes\\n", instruction_data_sz );

  tsdk_return( 0UL );
}
`;

const GAME_SCORE_SOURCE = `/* Game Score - Thru Program
 * instruction_data is an 8-byte little-endian points value to add to the
 * running high score stored in this program's own account data.
 */

#include <thru-sdk/c/tn_sdk.h>

TSDK_ENTRYPOINT_FN void
start( void const * instruction_data,
       ulong        instruction_data_sz ) {
  TSDK_ASSERT_OR_REVERT( instruction_data_sz == sizeof(ulong), 1UL );

  ushort const acc_idx = tsdk_get_current_program_acc_idx();
  TSDK_ASSERT_OR_REVERT( tsdk_account_exists( acc_idx ), 2UL );

  tsdk_account_meta_t const * meta = tsdk_get_account_meta( acc_idx );
  TSDK_ASSERT_OR_REVERT( meta->data_sz >= sizeof(ulong), 3UL );

  void * data = tsdk_get_account_data_ptr( acc_idx );

  ulong points = TSDK_LOAD( ulong, instruction_data );
  ulong score  = TSDK_LOAD( ulong, data );
  TSDK_ASSERT_OR_REVERT( points <= ~0UL - score, 4UL );
  score += points;
  TSDK_STORE( ulong, data, score );

  tsdk_printf( "score: %lu (+%lu)\\n", score, points );

  tsdk_return( 0UL );
}
`;

export const TEMPLATES: ThruTemplate[] = [
  {
    id: "counter",
    name: "Counter",
    description: "Increments a number stored on-chain every time it runs.",
    fileName: "counter.c",
    accountDataBytes: 8,
    instructionFormat: "No instruction data",
    source: COUNTER_SOURCE,
  },
  {
    id: "message_storage",
    name: "Message Storage",
    description: "Saves a short message you send it into the program's account.",
    fileName: "message_storage.c",
    accountDataBytes: 8,
    instructionFormat: "Raw message bytes",
    source: MESSAGE_STORAGE_SOURCE,
  },
  {
    id: "game_score",
    name: "Game Score",
    description: "Adds points to a running high score on-chain.",
    fileName: "game_score.c",
    accountDataBytes: 8,
    instructionFormat: "8-byte little-endian unsigned points",
    source: GAME_SCORE_SOURCE,
  },
  {
    id: "blank",
    name: "Blank",
    description: "The official hello-world starting point — build your own from here.",
    fileName: "program.c",
    accountDataBytes: 0,
    instructionFormat: "No instruction data",
    source: BLANK_SOURCE,
  },
];

export function getTemplate(id: string): ThruTemplate {
  const found = TEMPLATES.find((t) => t.id === id);
  return found ?? TEMPLATES[TEMPLATES.length - 1];
}

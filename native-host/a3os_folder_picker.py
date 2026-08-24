import sys
import json
import struct
import base64
import re
import shutil
import os
import tkinter as tk
from tkinter import filedialog


# ================================================================
# LOG (stderr apenas - stdout e reservado ao protocolo Native Messaging)
# ================================================================

def log(message):

    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:
        pass


# ================================================================
# ENVIAR MENSAGEM PARA O CHROME
# ================================================================

def send_message(message):

    encoded = json.dumps(
        message,
        ensure_ascii=False
    ).encode("utf-8")

    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ================================================================
# LER MENSAGEM DO CHROME
# ================================================================

def read_message():

    raw_length = sys.stdin.buffer.read(4)

    if not raw_length or len(raw_length) < 4:
        return None

    message_length = struct.unpack("<I", raw_length)[0]

    message = sys.stdin.buffer.read(message_length)

    if not message:
        return None

    return json.loads(message.decode("utf-8"))


# ================================================================
# SELECIONAR PASTA
# ================================================================

def escolher_pasta():

    try:

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        root.update()

        pasta = filedialog.askdirectory(
            parent=root,
            title="Selecionar pasta para salvar as gravacoes do A3-OS"
        )

        root.destroy()

        if pasta:

            return {
                "success": True,
                "folder": pasta
            }

        return {
            "success": False,
            "cancelled": True
        }

    except Exception as error:

        log("Erro ao selecionar pasta: " + str(error))

        return {
            "success": False,
            "error": str(error)
        }


# ================================================================
# SANITIZAR NOME DE ARQUIVO
# ================================================================

INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitizar_filename(filename):

    filename = (filename or "").strip()

    filename = INVALID_FILENAME_CHARS.sub("", filename)

    filename = re.sub(r"\s+", " ", filename).strip()

    if not filename or filename in (".", ".."):
        filename = "aula"

    if not filename.lower().endswith(".webm"):
        filename += ".webm"

    return filename


# ================================================================
# RESOLVER COLISAO DE NOME (aula.webm, aula (1).webm, aula (2).webm, ...)
# ================================================================

def caminho_unico(destination, filename):

    target = os.path.join(destination, filename)

    if not os.path.exists(target):
        return target

    name, extension = os.path.splitext(filename)

    counter = 1

    while True:

        candidate = os.path.join(
            destination,
            f"{name} ({counter}){extension}"
        )

        if not os.path.exists(candidate):
            return candidate

        counter += 1


# ================================================================
# SALVAR AUDIO (recebido em chunks Base64)
# ================================================================

def salvar_audio(folder, filename, chunks):

    try:

        if not folder or not str(folder).strip():
            raise Exception("Pasta de destino nao informada.")

        if not chunks or not isinstance(chunks, list):
            raise Exception("Nenhum dado de audio recebido.")

        folder = os.path.abspath(folder)

        if os.path.exists(folder) and not os.path.isdir(folder):
            raise Exception("O caminho informado nao e uma pasta: " + folder)

        os.makedirs(folder, exist_ok=True)

        filename = sanitizar_filename(filename)

        target = caminho_unico(folder, filename)

        bytes_escritos = 0

        with open(target, "wb") as handle:

            for chunk in chunks:

                dados = base64.b64decode(chunk)

                handle.write(dados)

                bytes_escritos += len(dados)

        # ====================================================
        # VERIFICACAO REAL NA PASTA: confirma que o arquivo
        # existe de fato no disco e que o tamanho gravado bate
        # com o que foi escrito, antes de reportar sucesso.
        # ====================================================

        if not os.path.isfile(target):
            raise Exception(
                "Verificacao falhou: arquivo nao encontrado na pasta apos salvar: "
                + target
            )

        tamanho_no_disco = os.path.getsize(target)

        if tamanho_no_disco != bytes_escritos:
            raise Exception(
                "Verificacao falhou: tamanho do arquivo na pasta ({} bytes) "
                "nao corresponde ao esperado ({} bytes).".format(
                    tamanho_no_disco, bytes_escritos
                )
            )

        if tamanho_no_disco == 0:
            raise Exception(
                "Verificacao falhou: o arquivo salvo esta vazio: " + target
            )

        log(
            "Audio salvo e verificado em: "
            + target
            + " (" + str(tamanho_no_disco) + " bytes)"
        )

        return {
            "success": True,
            "path": target,
            "filename": os.path.basename(target),
            "size": tamanho_no_disco
        }

    except Exception as error:

        log("Erro ao salvar audio: " + str(error))

        return {
            "success": False,
            "error": str(error)
        }


# ================================================================
# MOVER ARQUIVO (mantido por compatibilidade)
# ================================================================

def mover_arquivo(source, destination):

    try:

        if not source:
            raise Exception("Arquivo de origem nao informado.")

        if not destination:
            raise Exception("Pasta de destino nao informada.")

        source = os.path.abspath(source)
        destination = os.path.abspath(destination)

        if not os.path.exists(source):
            raise Exception("Arquivo de origem nao encontrado: " + source)

        os.makedirs(destination, exist_ok=True)

        filename = os.path.basename(source)

        target = caminho_unico(destination, filename)

        shutil.move(source, target)

        return {
            "success": True,
            "path": target
        }

    except Exception as error:

        return {
            "success": False,
            "error": str(error)
        }


# ================================================================
# PRINCIPAL
# ================================================================

def main():

    log("A3-OS Native Host iniciado.")

    while True:

        try:

            message = read_message()

            if message is None:
                break

            action = message.get("action")

            # ====================================================
            # SELECIONAR PASTA
            # ====================================================

            if action == "select-folder":

                send_message(escolher_pasta())

            # ====================================================
            # SALVAR AUDIO
            # ====================================================

            elif action == "save-audio":

                send_message(
                    salvar_audio(
                        message.get("folder"),
                        message.get("filename"),
                        message.get("chunks")
                    )
                )

            # ====================================================
            # MOVER ARQUIVO
            # ====================================================

            elif action == "move-file":

                send_message(
                    mover_arquivo(
                        message.get("source"),
                        message.get("destination")
                    )
                )

            # ====================================================
            # ACAO DESCONHECIDA
            # ====================================================

            else:

                send_message({
                    "success": False,
                    "error": "Acao desconhecida."
                })

        except Exception as error:

            log("Erro no loop principal: " + str(error))

            try:
                send_message({
                    "success": False,
                    "error": str(error)
                })
            except Exception:
                break


if __name__ == "__main__":
    main()

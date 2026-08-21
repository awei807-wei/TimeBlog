package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

type recoveryKeyOutput struct {
	path   string
	name   string
	parent *os.File
	file   *os.File
	device uint64
	inode  uint64
}

func createRecoveryKeyOutput(path, secret string) (output *recoveryKeyOutput, resultErr error) {
	parentPath := filepath.Dir(path)
	resolvedParent, err := filepath.EvalSymlinks(parentPath)
	if err != nil {
		return nil, fmt.Errorf("resolve recovery key output directory: %w", err)
	}
	if filepath.Clean(resolvedParent) != filepath.Clean(parentPath) {
		return nil, errors.New("recovery key output directory must not contain symbolic links")
	}
	parent, err := os.Open(resolvedParent)
	if err != nil {
		return nil, fmt.Errorf("open recovery key output directory: %w", err)
	}
	if err = validateRecoveryOutputParent(parent); err != nil {
		_ = parent.Close()
		return nil, err
	}

	name := filepath.Base(path)
	fd, err := unix.Openat(int(parent.Fd()), name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		_ = parent.Close()
		return nil, fmt.Errorf("create recovery key output without overwrite: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	output = &recoveryKeyOutput{path: path, name: name, parent: parent, file: file}
	defer func() {
		if resultErr == nil {
			return
		}
		resultErr = errors.Join(resultErr, output.Remove(), output.Close())
		output = nil
	}()
	var stat unix.Stat_t
	if err = unix.Fstat(int(file.Fd()), &stat); err != nil {
		return output, fmt.Errorf("stat recovery key output: %w", err)
	}
	output.device = uint64(stat.Dev)
	output.inode = stat.Ino

	if err = file.Chmod(0o600); err != nil {
		return output, fmt.Errorf("secure recovery key output permissions: %w", err)
	}
	if _, err = io.WriteString(file, secret+"\n"); err != nil {
		return output, fmt.Errorf("write recovery key output: %w", err)
	}
	if err = file.Sync(); err != nil {
		return output, fmt.Errorf("sync recovery key output: %w", err)
	}
	if err = parent.Sync(); err != nil {
		return output, fmt.Errorf("sync recovery key output directory: %w", err)
	}
	if err = output.Verify(); err != nil {
		return output, err
	}
	return output, nil
}

func validateRecoveryOutputParent(parent *os.File) error {
	var stat unix.Stat_t
	if err := unix.Fstat(int(parent.Fd()), &stat); err != nil {
		return fmt.Errorf("stat recovery key output directory: %w", err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return errors.New("recovery key output parent is not a directory")
	}
	if stat.Mode&0o777 != 0o700 {
		return fmt.Errorf("recovery key output directory must have 0700 permissions, got %04o", stat.Mode&0o777)
	}
	if stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("recovery key output directory must be owned by effective uid %d", os.Geteuid())
	}
	return nil
}

func (output *recoveryKeyOutput) Verify() error {
	var opened, linked unix.Stat_t
	if err := unix.Fstat(int(output.file.Fd()), &opened); err != nil {
		return fmt.Errorf("stat opened recovery key output: %w", err)
	}
	if err := unix.Fstatat(int(output.parent.Fd()), output.name, &linked, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return fmt.Errorf("stat linked recovery key output: %w", err)
	}
	if uint64(opened.Dev) != output.device || opened.Ino != output.inode || uint64(linked.Dev) != output.device || linked.Ino != output.inode {
		return errors.New("recovery key output path no longer references the created file")
	}
	if opened.Mode&unix.S_IFMT != unix.S_IFREG || opened.Mode&0o777 != 0o600 || opened.Nlink != 1 {
		return errors.New("recovery key output is not a single-link 0600 regular file")
	}
	return nil
}

func (output *recoveryKeyOutput) Remove() error {
	if output == nil || output.parent == nil || output.file == nil {
		return nil
	}
	if output.inode == 0 {
		if err := unix.Unlinkat(int(output.parent.Fd()), output.name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return err
		}
		return output.parent.Sync()
	}
	if err := output.Verify(); err != nil {
		return fmt.Errorf("refuse to remove replaced recovery key output: %w", err)
	}
	if err := unix.Unlinkat(int(output.parent.Fd()), output.name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return err
	}
	return output.parent.Sync()
}

func (output *recoveryKeyOutput) Close() error {
	if output == nil {
		return nil
	}
	var result error
	if output.file != nil {
		result = errors.Join(result, output.file.Close())
		output.file = nil
	}
	if output.parent != nil {
		result = errors.Join(result, output.parent.Close())
		output.parent = nil
	}
	return result
}
